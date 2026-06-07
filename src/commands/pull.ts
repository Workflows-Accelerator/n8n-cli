import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { getConnectionInfo, buildFolderPaths, validateCookie, fetchWorkflowsWithCookie, saveCookieToEnv, loadFolderCache, saveFolderCache, getWorkflowDetails } from '../config.js';
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
    .option('--skip-references', 'skip pulling reference workflows', false)
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .option('--cookie <cookie>', 'provide a new n8n auth cookie to update settings and sync folders')
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

        // Load folder cache
        let folderCache = loadFolderCache(repoRoot);

        // Determine which cookie to use
        let cookie = options.cookie || process.env.N8N_COOKIE || '';
        let cookieValid = false;

        if (cookie) {
          output.log('Validating N8N_COOKIE...');
          cookieValid = await validateCookie(instanceUrl, cookie);
          if (cookieValid) {
            output.log('N8N_COOKIE is active. Fetching workflow-to-folder relationships...');
            const internalWorkflows = await fetchWorkflowsWithCookie(instanceUrl, cookie);
            if (internalWorkflows) {
              const newCache: Record<string, string | null> = {};
              for (const w of internalWorkflows) {
                newCache[w.id] = w.parentFolderId || w.folderId || null;
              }
              folderCache = newCache;
              saveFolderCache(repoRoot, folderCache);
              output.log(`Successfully updated folder cache with ${Object.keys(folderCache).length} mappings.`);

              // Save new cookie to .env if provided via CLI
              if (options.cookie) {
                saveCookieToEnv(repoRoot, options.cookie);
                output.log('Saved new cookie to .env file.');
              }
            } else {
              output.warn('Active session returned no workflows. Folder cache not updated.');
            }
          } else {
            output.warn('N8N_COOKIE is invalid or expired. Folder structures might be out of date.');
            if (options.cookie) {
              output.error('The provided --cookie was rejected by the server.');
            }
          }
        } else {
          output.warn('N8N_COOKIE is missing. Folder structures might be out of date. You can provide a valid session cookie using --cookie.');
        }

        if (!apiKey) {
          throw new Error('N8N_API_KEY is not defined in the .env file. It is required to manage MCP settings on your n8n instance.');
        }

        output.log(`Pulling workflows for project '${config.projectName}'...`);

        const syncState = loadSyncState(repoRoot);
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
              const localWorkflowsDir = path.join(repoRoot!, 'n8n', 'workflows');
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

                const localWorkflowsDir = path.join(repoRoot!, 'n8n', 'workflows');
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

            // Handle local files that no longer exist on remote
            for (const [relPath, entry] of Object.entries(syncState.workflows)) {
              if (!activeWorkflowIds.has(entry.id)) {
                output.log(`  [REMOTE DELETED] Workflow '${entry.name}' (${relPath}) was deleted on remote.`);
                delete syncState.workflows[relPath];
              }
            }

            // Save sync state
            syncState.lastSync = new Date().toISOString();
            saveSyncState(repoRoot!, syncState);

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

