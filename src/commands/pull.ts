import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { getConnectionInfo, buildFolderPaths } from '../config.js';
import { withMcp } from '../mcp-client.js';
import { loadSyncState, saveSyncState, calculateHash, SyncWorkflowEntry } from '../sync-state.js';
import { pullReferences } from '../references.js';
import { generateWorkflowCode, parseWorkflowCodeToBuilder } from '@n8n/workflow-sdk';
import * as output from '../output.js';

async function temporarilyEnableMcp(
  instanceUrl: string,
  apiKey: string,
  projectId: string
): Promise<Record<string, boolean>> {
  const headers = {
    'X-N8N-API-KEY': apiKey,
    'Content-Type': 'application/json',
  };
  
  const listRes = await fetch(`${instanceUrl}/api/v1/workflows?projectId=${projectId}&limit=250`, { headers });
  if (!listRes.ok) {
    throw new Error(`Failed to list workflows via REST API for project ${projectId}: ${listRes.statusText}`);
  }
  const listData = (await listRes.json()) as any;
  const workflows = Array.isArray(listData) ? listData : (listData.data || listData.workflows || []);

  const mcpCache: Record<string, boolean> = {};
  for (const w of workflows) {
    const originalVal = w.settings?.availableInMCP ?? false;
    mcpCache[w.id] = originalVal;

    if (!originalVal) {
      output.log(`Temporarily enabling MCP access for workflow '${w.name}'...`);
      try {
        const detailRes = await fetch(`${instanceUrl}/api/v1/workflows/${w.id}`, { headers });
        if (!detailRes.ok) throw new Error(`Failed to get details for workflow ${w.id}`);
        const fullWf = (await detailRes.json()) as any;

        const updatedSettings = { ...fullWf.settings, availableInMCP: true };
        delete updatedSettings.binaryMode;

        const putRes = await fetch(`${instanceUrl}/api/v1/workflows/${w.id}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            name: fullWf.name,
            nodes: fullWf.nodes,
            connections: fullWf.connections,
            settings: updatedSettings,
          }),
        });
        if (!putRes.ok) {
          throw new Error(`PUT failed: ${await putRes.text()}`);
        }
      } catch (err) {
        output.error(`Failed to temporarily enable MCP for workflow '${w.name}': ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return mcpCache;
}

async function restoreMcpSettings(
  instanceUrl: string,
  apiKey: string,
  projectId: string,
  mcpCache: Record<string, boolean>,
  folderId?: string
) {
  const headers = {
    'X-N8N-API-KEY': apiKey,
    'Content-Type': 'application/json',
  };
  
  const listRes = await fetch(`${instanceUrl}/api/v1/workflows?projectId=${projectId}&limit=250`, { headers });
  if (!listRes.ok) {
    return;
  }
  const listData = (await listRes.json()) as any;
  const workflows = Array.isArray(listData) ? listData : (listData.data || listData.workflows || []);

  for (const w of workflows) {
    const originalVal = mcpCache[w.id];
    if (originalVal === undefined) {
      continue;
    }

    const wFolderId = w.parentFolderId || w.folderId;
    const isInScope = !folderId || (wFolderId === folderId);

    if (!isInScope && !originalVal) {
      output.log(`Restoring MCP access to false for out-of-scope workflow '${w.name}'...`);
      try {
        const detailRes = await fetch(`${instanceUrl}/api/v1/workflows/${w.id}`, { headers });
        if (!detailRes.ok) throw new Error(`Failed to get details`);
        const fullWf = (await detailRes.json()) as any;

        const updatedSettings = { ...fullWf.settings, availableInMCP: false };
        delete updatedSettings.binaryMode;

        const putRes = await fetch(`${instanceUrl}/api/v1/workflows/${w.id}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            name: fullWf.name,
            nodes: fullWf.nodes,
            connections: fullWf.connections,
            settings: updatedSettings,
          }),
        });
        if (!putRes.ok) {
          throw new Error(`PUT failed: ${await putRes.text()}`);
        }
      } catch (err) {
        output.error(`Failed to restore MCP for workflow '${w.name}': ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

export function pullCommand(program: Command) {
  program
    .command('pull')
    .description('Pull workflows from n8n instance and convert them to TypeScript SDK files')
    .option('--force', 'overwrite local modifications without confirmation', false)
    .option('--skip-references', 'skip pulling reference workflows', false)
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (options) => {
      let mainMcpCache: Record<string, boolean> = {};
      let refMcpCache: Record<string, boolean> = {};
      let projectId = '';
      let refProjId = '';
      let instanceUrl = '';
      let apiKey = '';
      let folderId: string | undefined;
      let refFolderId: string | undefined;
      let repoRoot: string | null = null;
      let mcpCommand = '';
      let accessToken = '';

      try {
        const connectionInfo = getConnectionInfo(options);
        repoRoot = connectionInfo.repoRoot;
        mcpCommand = connectionInfo.mcpCommand;
        accessToken = connectionInfo.accessToken;
        const config = connectionInfo.config;

        if (!config || !repoRoot) {
          throw new Error('Project must be initialized. Run `n8ncli init` first.');
        }

        projectId = config.projectId;
        folderId = config.folderId;
        refProjId = config.references?.projectId || '';
        refFolderId = config.references?.folderId;
        instanceUrl = config.instanceUrl;
        apiKey = process.env.N8N_API_KEY || '';

        if (!apiKey) {
          throw new Error('N8N_API_KEY is not defined in the .env file. It is required to manage MCP settings on your n8n instance.');
        }

        output.log(`Pulling workflows for project '${config.projectName}'...`);

        // 1. Temporarily enable MCP for the main project
        mainMcpCache = await temporarilyEnableMcp(instanceUrl, apiKey, projectId);

        // 2. Temporarily enable MCP for the reference project if it is configured and different
        if (refProjId && refProjId !== projectId) {
          refMcpCache = await temporarilyEnableMcp(instanceUrl, apiKey, refProjId);
        } else if (refProjId === projectId) {
          refMcpCache = mainMcpCache;
        }

        const syncState = loadSyncState(repoRoot);
        const activeWorkflowIds = new Set<string>();

        let createdCount = 0;
        let updatedCount = 0;
        let unchangedCount = 0;
        let skippedCount = 0;

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          // Fetch folders to build path hierarchy and pre-create directories
          let folderPaths: Record<string, string> = {};
          try {
            const foldersResponse = await mcp.callToolAndGetJson('search_folders', { projectId });
            const folders = Array.isArray(foldersResponse) ? foldersResponse : (foldersResponse.folders || foldersResponse.data || []);
            folderPaths = buildFolderPaths(folders, folderId);
            
            // Create all directories (even empty ones)
            const localWorkflowsDir = path.join(repoRoot!, 'n8n', 'workflows');
            fs.mkdirSync(localWorkflowsDir, { recursive: true });
            for (const subdir of Object.values(folderPaths)) {
              fs.mkdirSync(path.join(localWorkflowsDir, subdir), { recursive: true });
            }
          } catch (err) {
            output.warn(`Failed to fetch folders or create directories: ${err instanceof Error ? err.message : String(err)}`);
          }

          // 1. Fetch remote workflows list
          const searchResponse = await mcp.callToolAndGetJson('search_workflows', {
            projectId,
            limit: 200,
          });

          const workflows = Array.isArray(searchResponse) ? searchResponse : (searchResponse.data || searchResponse.workflows || []);
          const availableWorkflows = workflows.filter((w: any) => w.availableInMCP === true);
          
          // Fetch remote details of all workflows and filter by folder configured
          const targetWorkflows = [];
          for (const w of availableWorkflows) {
            try {
              const detailsRes = await mcp.callToolAndGetJson('get_workflow_details', {
                workflowId: w.id,
                id: w.id,
              });
              const details = detailsRes.workflow || detailsRes;
              
              const wFolderId = details.parentFolderId || details.folderId;
              if (folderId && wFolderId !== folderId) {
                continue;
              }
              targetWorkflows.push({ w, details });
            } catch (err) {
              output.error(`Failed to fetch details for workflow '${w.name}': ${err instanceof Error ? err.message : String(err)}`);
              skippedCount++;
            }
          }

          output.log(`Found ${targetWorkflows.length} workflows in scope.`);

          const sanitizeFilename = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_');

          for (const { w, details } of targetWorkflows) {
            activeWorkflowIds.add(w.id);

            try {
              // 3. Generate TypeScript SDK code
              const tsCode = generateWorkflowCode(details);

              // 4. Validate the TS code (ensure it parses back successfully)
              try {
                const builder = parseWorkflowCodeToBuilder(tsCode);
                const validation = builder.validate();
                if (validation.errors.length > 0) {
                  output.warn(`Workflow '${details.name}' generated TS code has validation errors:`);
                  for (const err of validation.errors) {
                    output.warn(`  - ${err.message}`);
                  }
                }
              } catch (err) {
                output.warn(`Could not validate parsed code for '${details.name}': ${err instanceof Error ? err.message : String(err)}`);
              }

              // 5. Determine local file path
              const wFolderId = details.parentFolderId || details.folderId;
              const folderSubdir = wFolderId ? (folderPaths[wFolderId] || '') : '';

              const localWorkflowsDir = path.join(repoRoot!, 'n8n', 'workflows');
              const targetDir = folderSubdir ? path.join(localWorkflowsDir, folderSubdir) : localWorkflowsDir;
              const filename = `${sanitizeFilename(details.name)}.workflow.ts`;
              const relativePath = folderSubdir ? `${folderSubdir}/${filename}` : filename;
              const fullPath = path.join(targetDir, filename);

              const newHash = calculateHash(tsCode);
              let localExists = fs.existsSync(fullPath);
              let localContent = localExists ? fs.readFileSync(fullPath, 'utf-8') : '';
              let localHash = localExists ? calculateHash(localContent) : '';

              // Find current state entry
              const stateEntry = Object.values(syncState.workflows).find(entry => entry.id === details.id);

              if (!localExists) {
                // Scenario A: File doesn't exist locally -> create it
                fs.mkdirSync(targetDir, { recursive: true });
                fs.writeFileSync(fullPath, tsCode, 'utf-8');
                
                syncState.workflows[relativePath] = {
                  id: details.id,
                  name: details.name,
                  localPath: relativePath,
                  contentHash: newHash,
                  remoteUpdatedAt: details.updatedAt || new Date().toISOString(),
                  folderId: details.parentFolderId || details.folderId,
                };
                createdCount++;
                output.log(`  [CREATED] ${relativePath}`);
              } else if (localHash === newHash) {
                // Scenario B: Hashes match -> unchanged
                // Just update sync entry path in case it changed/moved
                delete syncState.workflows[stateEntry?.localPath || ''];
                syncState.workflows[relativePath] = {
                  id: details.id,
                  name: details.name,
                  localPath: relativePath,
                  contentHash: newHash,
                  remoteUpdatedAt: details.updatedAt || new Date().toISOString(),
                  folderId: details.parentFolderId || details.folderId,
                };
                unchangedCount++;
              } else {
                // Scenario C: Hashes differ -> check if local was modified
                const isLocalModified = stateEntry && stateEntry.contentHash !== localHash;

                if (isLocalModified && !options.force) {
                  output.warn(`  [CONFLICT] '${relativePath}' has local modifications. Skipping. Use --force to overwrite.`);
                  skippedCount++;
                } else {
                  // Write file (overwrite local changes or update to latest remote)
                  fs.mkdirSync(targetDir, { recursive: true });
                  fs.writeFileSync(fullPath, tsCode, 'utf-8');
                  
                  delete syncState.workflows[stateEntry?.localPath || ''];
                  syncState.workflows[relativePath] = {
                    id: details.id,
                    name: details.name,
                    localPath: relativePath,
                    contentHash: newHash,
                    remoteUpdatedAt: details.updatedAt || new Date().toISOString(),
                    folderId: details.parentFolderId || details.folderId,
                  };
                  updatedCount++;
                  output.log(`  [UPDATED] ${relativePath}`);
                }
              }
            } catch (err) {
              output.error(`Failed to pull workflow '${w.name}': ${err instanceof Error ? err.message : String(err)}`);
              skippedCount++;
            }
          }

          // 6. Handle local files that no longer exist on remote
          for (const [relPath, entry] of Object.entries(syncState.workflows)) {
            if (!activeWorkflowIds.has(entry.id)) {
              output.log(`  [REMOTE DELETED] Workflow '${entry.name}' (${relPath}) was deleted on remote.`);
              delete syncState.workflows[relPath];
            }
          }

          // 7. Save sync state
          syncState.lastSync = new Date().toISOString();
          saveSyncState(repoRoot!, syncState);

          // 8. Pull references
          if (!options.skipReferences) {
            await pullReferences(mcp, config, repoRoot!);
          }
        });

        output.log('Pull complete summary:');
        output.list([
          `Created: ${createdCount}`,
          `Updated: ${updatedCount}`,
          `Unchanged: ${unchangedCount}`,
          `Skipped/Conflict: ${skippedCount}`,
        ]);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        if (instanceUrl && apiKey && projectId) {
          output.log('Restoring MCP access settings for the project(s)...');
          try {
            await restoreMcpSettings(instanceUrl, apiKey, projectId, mainMcpCache, folderId);
          } catch (err) {
            output.error(`Failed to restore main project MCP settings: ${err instanceof Error ? err.message : String(err)}`);
          }
          if (refProjId && refProjId !== projectId) {
            try {
              await restoreMcpSettings(instanceUrl, apiKey, refProjId, refMcpCache, refFolderId);
            } catch (err) {
              output.error(`Failed to restore references project MCP settings: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
    });
}
