import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { generateWorkflowCode, parseWorkflowCode } from '@n8n/workflow-sdk';
import { McpClient } from './mcp-client.js';
import { N8nCliConfig, buildFolderPaths, getWorkflowDetails } from './config.js';
import * as output from './output.js';
import { glob } from 'glob';
import { calculateHash } from './sync-state.js';

export interface ReferenceWorkflowInfo {
  name: string;
  path: string;
  description: string;
}

export async function pullReferences(
  mcp: McpClient,
  config: N8nCliConfig,
  repoRoot: string,
  folderCache: Record<string, string | null> = {},
  instanceUrl: string = '',
  apiKey: string = ''
) {
  if (!config.references || !config.references.projectId) {
    output.debug('No reference project configured. Skipping reference pull.');
    return;
  }

  const refProjId = config.references.projectId;
  const refFolderId = config.references.folderId;

  output.log(`Pulling reference workflows from project: ${config.references.projectName}...`);

  const referencesDir = path.join(repoRoot, 'n8n', 'references');
  fs.mkdirSync(referencesDir, { recursive: true });

  let folderPaths: Record<string, string> = {};
  try {
    const foldersResponse = await mcp.callToolAndGetJson('search_folders', { projectId: refProjId });
    const folders = Array.isArray(foldersResponse) ? foldersResponse : (foldersResponse.folders || foldersResponse.data || []);
    folderPaths = buildFolderPaths(folders, refFolderId);
    
    for (const subdir of Object.values(folderPaths)) {
      fs.mkdirSync(path.join(referencesDir, subdir), { recursive: true });
    }
  } catch (err) {
    output.warn(`Failed to fetch reference folders: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    // 2. Fetch reference workflows using MCP
    const response = await mcp.callToolAndGetJson('search_workflows', {
      projectId: refProjId,
      limit: 100,
    });

    const workflows = Array.isArray(response) ? response : (response.data || response.workflows || []);
    const availableWorkflows = workflows.filter((w: any) => w.availableInMCP === true);
    
    // Fetch details of all reference workflows and filter by folder
    const targetWorkflows = [];
    for (const w of availableWorkflows) {
      if (w.isArchived) continue;
      try {
        const details = await getWorkflowDetails(mcp, instanceUrl, apiKey, w.id);
        
        let wFolderId = folderCache[w.id];
        if (wFolderId === undefined) {
          wFolderId = details.parentFolderId || details.folderId || null;
        }

        const isInScope = !refFolderId || (wFolderId === refFolderId) || (wFolderId && folderPaths[wFolderId] !== undefined);
        if (!isInScope) {
          continue;
        }
        targetWorkflows.push({ w, details, folderId: wFolderId });
      } catch (err) {
        output.warn(`Failed to fetch details for reference workflow '${w.name}': ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (targetWorkflows.length === 0) {
      output.warn('No reference workflows found matching the criteria.');
      return;
    }

    const workflowInfos: ReferenceWorkflowInfo[] = [];
    const activeRefPaths = new Set<string>();

    // Helper to clean up filenames
    const sanitizeFilename = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_');

    for (const { w, details, folderId: wFolderId } of targetWorkflows) {
      try {
        // Convert JSON to TS code
        const tsCode = generateWorkflowCode(details);

        // Determine directory based on folder names or folder hierarchy
        const folderSubdir = wFolderId ? (folderPaths[wFolderId] || '') : '';

        const targetDir = folderSubdir ? path.join(referencesDir, folderSubdir) : referencesDir;
        const filename = `${sanitizeFilename(details.name)}.workflow.ts`;
        const relativeFilePath = folderSubdir ? `${folderSubdir}/${filename}` : filename;
        const fullPath = path.join(targetDir, filename);

        activeRefPaths.add(relativeFilePath.replace(/\\/g, '/'));

        const newHash = calculateHash(tsCode);
        const localExists = fs.existsSync(fullPath);
        const localContent = localExists ? fs.readFileSync(fullPath, 'utf-8') : '';
        const localHash = localExists ? calculateHash(localContent) : '';

        if (localExists && localHash === newHash) {
          // Unchanged, skip writing
        } else {
          if (!localExists) {
            output.log(`  [CREATED] Reference: ${relativeFilePath}`);
          } else {
            output.log(`  [UPDATED] Reference: ${relativeFilePath}`);
          }
          fs.mkdirSync(targetDir, { recursive: true });
          fs.writeFileSync(fullPath, tsCode, 'utf-8');
        }

        // Extract description
        let description = details.description || '';
        if (!description) {
          // Fallback to searching the generated TS code or using a placeholder
          try {
            const parsed = parseWorkflowCode(tsCode);
            description = parsed.description || '';
          } catch (e) {
            // ignore
          }
        }

        workflowInfos.push({
          name: details.name,
          path: relativeFilePath,
          description: description || 'No description provided.',
        });
      } catch (err) {
        output.warn(`Failed to pull reference workflow '${w.name}': ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Clean up local reference files that are no longer in scope
    try {
      const localFiles = glob.sync('**/*.workflow.ts', { cwd: referencesDir });
      for (const localFile of localFiles) {
        const normalizedPath = localFile.replace(/\\/g, '/');
        if (!activeRefPaths.has(normalizedPath)) {
          const fullPath = path.join(referencesDir, normalizedPath);
          output.log(`  [DELETED] Reference: ${normalizedPath} (no longer in scope)`);
          fs.unlinkSync(fullPath);

          // Clean up empty directories
          try {
            let dir = path.dirname(fullPath);
            while (dir !== referencesDir) {
              if (fs.readdirSync(dir).length === 0) {
                fs.rmdirSync(dir);
                dir = path.dirname(dir);
              } else {
                break;
              }
            }
          } catch (e) {
            // ignore
          }
        }
      }
    } catch (e) {
      // ignore
    }

    // 2. Write index.yaml
    const indexPath = path.join(referencesDir, 'index.yaml');
    const yamlContent = YAML.stringify({ workflows: workflowInfos });
    fs.writeFileSync(
      indexPath,
      `# Auto-generated by n8ncli pull. Do not edit.\n# Read this file to find reference workflows, then read the .workflow.ts file for implementation details.\n\n${yamlContent}`,
      'utf-8'
    );
    output.log(`Reference workflows synchronized. Index generated at: n8n/references/index.yaml`);
  } catch (err) {
    output.warn(`Failed to pull references: ${err instanceof Error ? err.message : String(err)}`);
  }
}
