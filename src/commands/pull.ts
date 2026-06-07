import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { getConnectionInfo, buildFolderPaths, loadFolderCache, saveFolderCache, getWorkflowDetails, loadGlobalConfig, fetchWorkflowsWithDb, convertLocalJsonWorkflows } from '../config.js';
import { withMcp, McpClient } from '../mcp-client.js';
import { loadSyncState, saveSyncState, calculateHash, SyncWorkflowEntry } from '../sync-state.js';
import { pullReferences } from '../references.js';
import { generateWorkflowCode, parseWorkflowCodeToBuilder } from '@n8n/workflow-sdk';
import * as output from '../output.js';

async function temporarilyEnableMcp(
  mcp: McpClient,
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
    if (w.isArchived) continue;

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

        const updatedWf = {
          ...fullWf,
          settings: updatedSettings,
        };

        const tsCode = generateWorkflowCode(updatedWf);

        await mcp.callTool('update_workflow', {
          workflowId: w.id,
          code: tsCode,
          name: w.name,
        });
      } catch (err) {
        output.error(`Failed to temporarily enable MCP for workflow '${w.name}': ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return mcpCache;
}

async function restoreMcpSettings(
  mcp: McpClient,
  instanceUrl: string,
  apiKey: string,
  projectId: string,
  mcpCache: Record<string, boolean>,
  folderId?: string,
  folderPaths: Record<string, string> = {}
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
    if (w.isArchived) continue;

    const originalVal = mcpCache[w.id];
    if (originalVal === undefined || originalVal === true) {
      continue;
    }

    // Check scope via REST API/MCP details to preserve accurate parentFolderId
    let isInScope = false;
    try {
      const details = await getWorkflowDetails(mcp, instanceUrl, apiKey, w.id);
      const wFolderId = details.parentFolderId || details.folderId;
      isInScope = !folderId || (wFolderId === folderId) || (wFolderId && folderPaths[wFolderId] !== undefined);
    } catch (err) {
      // ignore, assume out of scope to safely restore
    }

    if (!isInScope) {
      output.log(`Restoring MCP access to false for out-of-scope workflow '${w.name}'...`);
      try {
        const detailRes = await fetch(`${instanceUrl}/api/v1/workflows/${w.id}`, { headers });
        if (!detailRes.ok) throw new Error(`Failed to get details`);
        const fullWf = (await detailRes.json()) as any;

        const updatedSettings = { ...fullWf.settings, availableInMCP: false };
        delete updatedSettings.binaryMode;

        const updatedWf = {
          ...fullWf,
          settings: updatedSettings,
        };

        const tsCode = generateWorkflowCode(updatedWf);

        await mcp.callTool('update_workflow', {
          workflowId: w.id,
          code: tsCode,
          name: w.name,
        });
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
    .option('--hard', 'delete untracked and out-of-scope local workflows to mirror remote state exactly', false)
    .option('--skip-references', 'skip pulling reference workflows', false)
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .option('--api-key <key>', 'override n8n REST API key')
    .option('--url <url>', 'override n8n instance URL')
    .option('--db-url <url>', 'override n8n PostgreSQL database connection URL')
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
      let dbUrl = '';

      try {
        const connectionInfo = getConnectionInfo(options);
        repoRoot = connectionInfo.repoRoot;
        mcpCommand = connectionInfo.mcpCommand;
        accessToken = connectionInfo.accessToken;
        apiKey = connectionInfo.apiKey;
        instanceUrl = connectionInfo.instanceUrl;
        dbUrl = connectionInfo.dbUrl;
        const config = connectionInfo.config;
        const localDir = connectionInfo.localDir;

        if (!config || !repoRoot) {
          throw new Error('Project must be initialized. Run `n8ncli init` first.');
        }

        convertLocalJsonWorkflows(path.join(repoRoot, localDir, 'workflows'));

        projectId = config.projectId;
        folderId = config.folderId;
        refProjId = config.references?.projectId || '';
        refFolderId = config.references?.folderId;

        // Load folder cache
        let folderCache = loadFolderCache(repoRoot, localDir);

        if (dbUrl) {
          output.log('Database URL configured. Fetching workflow-to-folder relationships from PostgreSQL...');
          try {
            const dbWorkflows = await fetchWorkflowsWithDb(dbUrl);
            if (dbWorkflows) {
              const newCache: Record<string, string | null> = {};
              for (const w of dbWorkflows) {
                newCache[w.id] = w.parentFolderId || null;
              }
              folderCache = newCache;
              saveFolderCache(repoRoot, folderCache, localDir);
              output.log(`Successfully updated folder cache from database with ${Object.keys(folderCache).length} mappings.`);
            } else {
              output.warn('Database query returned no workflows. Folder cache not updated.');
            }
          } catch (dbErr) {
            const dbErrMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
            output.warn(`Failed to sync folder mappings from database: ${dbErrMsg}`);
            output.warn('Proceeding with existing cached folder mappings...');
          }
        } else {
          output.warn('N8N_DB_URL is missing. Folder structures might be out of date.');
          output.log('Tip: You can set a global database connection URL using: n8ncli init --db-url="postgresql://user:pass@host/db"');
        }

        if (!apiKey) {
          throw new Error('N8N_API_KEY is not defined in the environment or global configuration. It is required to manage MCP settings on your n8n instance.');
        }

        output.log(`Pulling workflows for project '${config.projectName}'...`);

        const syncState = loadSyncState(repoRoot, localDir);
        const activeWorkflowIds = new Set<string>();

        let createdCount = 0;
        let updatedCount = 0;
        let unchangedCount = 0;
        let skippedCount = 0;

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          let folderPaths: Record<string, string> = {};
          
          try {
            // 1. Temporarily enable MCP for the main project
            mainMcpCache = await temporarilyEnableMcp(mcp, instanceUrl, apiKey, projectId);

            // 2. Temporarily enable MCP for the reference project if it is configured and different
            if (refProjId && refProjId !== projectId) {
              refMcpCache = await temporarilyEnableMcp(mcp, instanceUrl, apiKey, refProjId);
            } else if (refProjId === projectId) {
              refMcpCache = mainMcpCache;
            }

            // Fetch folders to build path hierarchy and pre-create directories
            try {
              const foldersResponse = await mcp.callToolAndGetJson('search_folders', { projectId });
              const folders = Array.isArray(foldersResponse) ? foldersResponse : (foldersResponse.folders || foldersResponse.data || []);
              folderPaths = buildFolderPaths(folders, folderId);
              
              // Create all directories (even empty ones)
              const localWorkflowsDir = path.join(repoRoot!, localDir, 'workflows');
              fs.mkdirSync(localWorkflowsDir, { recursive: true });
              for (const subdir of Object.values(folderPaths)) {
                fs.mkdirSync(path.join(localWorkflowsDir, subdir), { recursive: true });
              }
            } catch (err) {
              output.warn(`Failed to fetch folders or create directories: ${err instanceof Error ? err.message : String(err)}`);
            }

            // 3. Fetch remote workflows list
            const searchResponse = await mcp.callToolAndGetJson('search_workflows', {
              projectId,
              limit: 200,
            });

            const workflows = Array.isArray(searchResponse) ? searchResponse : (searchResponse.data || searchResponse.workflows || []);
            const availableWorkflows = workflows.filter((w: any) => w.availableInMCP === true);
            
            // Fetch remote details of all workflows and filter by folder configured
            const targetWorkflows = [];
            for (const w of availableWorkflows) {
              if (w.isArchived) continue;
              try {
                const details = await getWorkflowDetails(mcp, instanceUrl, apiKey, w.id);
                
                let wFolderId = folderCache[w.id];
                if (wFolderId === undefined) {
                  const stateEntry = Object.values(syncState.workflows).find(entry => entry.id === w.id);
                  if (stateEntry && stateEntry.folderId) {
                    wFolderId = stateEntry.folderId;
                  } else {
                    wFolderId = details.parentFolderId || details.folderId || null;
                    if (!wFolderId && !stateEntry) {
                      output.warn(`Warning: New workflow '${w.name}' (${w.id}) found but its folder mapping is unknown. It will be placed at the root of the workflows directory. Provide a valid cookie via --cookie to sync folders.`);
                    }
                  }
                }

                const isInScope = !folderId || (wFolderId === folderId) || (wFolderId && folderPaths[wFolderId] !== undefined);
                
                if (!isInScope) {
                  continue;
                }
                targetWorkflows.push({ w, details, folderId: wFolderId });
              } catch (err) {
                output.error(`Failed to fetch details for workflow '${w.name}': ${err instanceof Error ? err.message : String(err)}`);
                skippedCount++;
              }
            }

            output.log(`Found ${targetWorkflows.length} workflows in scope.`);

            const sanitizeFilename = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_');

            for (const { w, details, folderId: wFolderId } of targetWorkflows) {
              activeWorkflowIds.add(w.id);

              try {
                // Generate TypeScript SDK code
                const tsCode = generateWorkflowCode(details);

                // Validate the TS code (ensure it parses back successfully)
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

                // Determine local file path
                const folderSubdir = wFolderId ? (folderPaths[wFolderId] || '') : '';

                const localWorkflowsDir = path.join(repoRoot!, localDir, 'workflows');
                const targetDir = folderSubdir ? path.join(localWorkflowsDir, folderSubdir) : localWorkflowsDir;
                const filename = `${sanitizeFilename(details.name)}.workflow.ts`;
                const relativePath = folderSubdir ? `${folderSubdir}/${filename}` : filename;
                const fullPath = path.join(targetDir, filename);

                // Find current state entry
                let stateEntry = Object.values(syncState.workflows).find(entry => entry.id === details.id);

                // If the workflow already exists locally but at a different path (implying folder changes)
                if (stateEntry && stateEntry.localPath !== relativePath) {
                  const oldFullPath = path.join(localWorkflowsDir, stateEntry.localPath);
                  if (fs.existsSync(oldFullPath)) {
                    output.log(`  Moving local file on disk: ${stateEntry.localPath} -> ${relativePath}`);
                    fs.mkdirSync(targetDir, { recursive: true });
                    fs.renameSync(oldFullPath, fullPath);

                    // Clean up empty parent directories of the old file
                    try {
                      let dir = path.dirname(oldFullPath);
                      while (dir !== localWorkflowsDir) {
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
                  // Remove old entry from sync state
                  delete syncState.workflows[stateEntry.localPath];
                  stateEntry = undefined;
                }

                const newHash = calculateHash(tsCode);
                let localExists = fs.existsSync(fullPath);
                let localContent = localExists ? fs.readFileSync(fullPath, 'utf-8') : '';
                let localHash = localExists ? calculateHash(localContent) : '';

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
                    folderId: wFolderId,
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
                    folderId: wFolderId,
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
                      folderId: wFolderId,
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

            // Handle local files that no longer exist on remote or are out of scope
            for (const [relPath, entry] of Object.entries(syncState.workflows)) {
              if (!activeWorkflowIds.has(entry.id)) {
                const fullPath = path.join(repoRoot!, localDir, 'workflows', relPath);
                if (fs.existsSync(fullPath)) {
                  fs.unlinkSync(fullPath);
                  output.log(`  [CLEANUP] Deleted local file for out-of-scope/deleted workflow: ${relPath}`);
                  
                  // Clean up empty parent directories
                  let dir = path.dirname(fullPath);
                  const localWorkflowsDir = path.join(repoRoot!, localDir, 'workflows');
                  while (dir !== localWorkflowsDir) {
                    const relDir = path.relative(localWorkflowsDir, dir).replace(/\\/g, '/');
                    const isRemoteFolder = Object.values(folderPaths).includes(relDir);
                    if (!isRemoteFolder && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
                      fs.rmdirSync(dir);
                      dir = path.dirname(dir);
                    } else {
                      break;
                    }
                  }
                }
                delete syncState.workflows[relPath];
              }
            }

            // If hard sync is requested, scan for and delete any untracked workflow files on disk
            if (options.hard) {
              const localWorkflowsDir = path.join(repoRoot!, localDir, 'workflows');
              if (fs.existsSync(localWorkflowsDir)) {
                const getWorkflowFiles = (dir: string): string[] => {
                  let results: string[] = [];
                  if (!fs.existsSync(dir)) return results;
                  const list = fs.readdirSync(dir, { withFileTypes: true });
                  for (const file of list) {
                    const filePath = path.join(dir, file.name);
                    if (file.isDirectory()) {
                      results = results.concat(getWorkflowFiles(filePath));
                    } else if (file.isFile() && file.name.endsWith('.workflow.ts')) {
                      results.push(filePath);
                    }
                  }
                  return results;
                };

                const files = getWorkflowFiles(localWorkflowsDir);
                for (const fullPath of files) {
                  try {
                    const content = fs.readFileSync(fullPath, 'utf-8');
                    const match = content.match(/workflow\(\s*['"]([^'"]+)['"]/);
                    const id = match ? match[1] : null;
                    if (!id || !activeWorkflowIds.has(id)) {
                      fs.unlinkSync(fullPath);
                      const rel = path.relative(localWorkflowsDir, fullPath);
                      output.log(`  [HARD CLEANUP] Deleted local file: ${rel}`);

                      // Clean up empty parent directories
                      let dir = path.dirname(fullPath);
                      while (dir !== localWorkflowsDir) {
                        const relDir = path.relative(localWorkflowsDir, dir).replace(/\\/g, '/');
                        const isRemoteFolder = Object.values(folderPaths).includes(relDir);
                        if (!isRemoteFolder && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
                          fs.rmdirSync(dir);
                          dir = path.dirname(dir);
                        } else {
                          break;
                        }
                      }
                    }
                  } catch (e) {
                    // ignore
                  }
                }
              }
            }

            // Save sync state
            syncState.lastSync = new Date().toISOString();
            syncState.folders = Object.keys(folderPaths);
            saveSyncState(repoRoot!, syncState, localDir);

            // Pull references
            if (!options.skipReferences) {
              await pullReferences(mcp, config, repoRoot!, folderCache, instanceUrl, apiKey);
            }
          } finally {
            output.log('Restoring MCP access settings for the project(s)...');
            try {
              await restoreMcpSettings(mcp, instanceUrl, apiKey, projectId, mainMcpCache, folderId, folderPaths);
            } catch (err) {
              output.error(`Failed to restore main project MCP settings: ${err instanceof Error ? err.message : String(err)}`);
            }
            if (refProjId && refProjId !== projectId) {
              try {
                let refFolderPaths: Record<string, string> = {};
                try {
                  const foldersResponse = await mcp.callToolAndGetJson('search_folders', { projectId: refProjId });
                  const folders = Array.isArray(foldersResponse) ? foldersResponse : (foldersResponse.folders || foldersResponse.data || []);
                  refFolderPaths = buildFolderPaths(folders, refFolderId);
                } catch (e) {
                  // ignore
                }
                await restoreMcpSettings(mcp, instanceUrl, apiKey, refProjId, refMcpCache, refFolderId, refFolderPaths);
              } catch (err) {
                output.error(`Failed to restore references project MCP settings: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
        });

        output.log('Pull complete summary:');
        output.log(`  - Created: ${createdCount}`);
        output.log(`  - Updated: ${updatedCount}`);
        output.log(`  - Unchanged: ${unchangedCount}`);
        output.log(`  - Skipped/Conflict: ${skippedCount}`);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

