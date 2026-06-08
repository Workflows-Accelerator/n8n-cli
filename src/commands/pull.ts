import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { getConnectionInfo, buildFolderPaths, loadFolderCache, saveFolderCache, getWorkflowDetails, loadGlobalConfig, fetchWorkflowsWithDb, convertLocalJsonWorkflows, syncCredentials } from '../config.js';
import { withMcp, McpClient } from '../mcp-client.js';
import { loadSyncState, saveSyncState, calculateHash, SyncWorkflowEntry } from '../sync-state.js';
import { pullReferences } from '../references.js';
import { generateWorkflowCode, parseWorkflowCodeToBuilder } from '@n8n/workflow-sdk';
import * as output from '../output.js';

async function fetchWorkflowsPaginated(
  instanceUrl: string,
  projectId: string,
  headers: Record<string, string>,
  retries = 3
): Promise<any[]> {
  let workflows: any[] = [];
  let cursor = '';
  while (true) {
    const url = `${instanceUrl}/api/v1/workflows?projectId=${projectId}&limit=250${cursor ? `&cursor=${cursor}` : ''}`;
    let data: any = null;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, { headers });
        if (res.ok) {
          data = await res.json();
          break;
        }
        if (res.status === 429 && attempt < retries) {
          output.warn(`Rate limit listing workflows. Retrying in 2 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        if (attempt === retries) {
          throw new Error(`REST API listing failed with status ${res.status}: ${res.statusText}`);
        }
      } catch (err) {
        if (attempt === retries) throw err;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    const pageWorkflows = Array.isArray(data) ? data : (data.data || data.workflows || []);
    workflows = workflows.concat(pageWorkflows);
    
    const nextCursor = data?.nextCursor;
    if (!nextCursor || pageWorkflows.length === 0) {
      break;
    }
    cursor = nextCursor;
  }
  return workflows;
}

async function enableMcpForWorkflow(
  mcp: McpClient,
  instanceUrl: string,
  apiKey: string,
  w: any,
  enable: boolean
) {
  const fullWf = await getWorkflowDetails(mcp, instanceUrl, apiKey, w.id);
  const updatedSettings = { ...fullWf.settings, availableInMCP: enable };
  delete updatedSettings.binaryMode;

  const updatedWf = {
    ...fullWf,
    settings: updatedSettings,
  };

  if (apiKey && instanceUrl) {
    try {
      const cleanInstanceUrl = instanceUrl.replace(/\/$/, '');
      const res = await fetch(`${cleanInstanceUrl}/api/v1/workflows/${w.id}`, {
        method: 'PUT',
        headers: {
          'X-N8N-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updatedWf),
      });

      if (res.ok) {
        return;
      }
      output.warn(`REST API update for workflow '${w.name || w.id}' returned status ${res.status}: ${res.statusText}. Falling back to MCP...`);
    } catch (apiErr) {
      output.warn(`REST API update for workflow '${w.name || w.id}' failed: ${apiErr instanceof Error ? apiErr.message : String(apiErr)}. Falling back to MCP...`);
    }
  }

  const tsCode = generateWorkflowCode(updatedWf);

  await mcp.callTool('update_workflow', {
    workflowId: w.id,
    code: tsCode,
    name: w.name,
    operations: [],
  });
}

async function temporarilyEnableMcp(
  mcp: McpClient,
  instanceUrl: string,
  apiKey: string,
  projectId: string,
  folderId?: string,
  folderPaths: Record<string, string> = {},
  folderCache: Record<string, string | null> = {}
): Promise<Record<string, boolean>> {
  const headers = {
    'X-N8N-API-KEY': apiKey,
    'Content-Type': 'application/json',
  };
  
  const workflows = await fetchWorkflowsPaginated(instanceUrl, projectId, headers);

  const restoreMcpCache: Record<string, boolean> = {};
  for (const w of workflows) {
    if (w.isArchived) continue;

    const originalVal = w.settings?.availableInMCP ?? false;
    
    // Resolve folder from cache if available
    let wFolderId = folderCache[w.id];
    let isKnownScope = wFolderId !== undefined || !folderId;
    let isInScope = false;
    if (isKnownScope) {
      wFolderId = wFolderId || null;
      isInScope = !folderId || (wFolderId === folderId) || (wFolderId ? folderPaths[wFolderId] !== undefined : false);
    }

    if (isKnownScope) {
      if (isInScope) {
        if (!originalVal) {
          output.log(`Enabling MCP access permanently for in-scope workflow '${w.name}'...`);
          try {
            await enableMcpForWorkflow(mcp, instanceUrl, apiKey, w, true);
          } catch (e) {
            output.error(`Failed to enable MCP for workflow '${w.name}': ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } else {
        // Out of scope: do nothing!
      }
    } else {
      // Unknown scope: we must temporarily enable MCP, fetch details, check scope, and restore if out of scope
      if (!originalVal) {
        output.log(`Temporarily enabling MCP access for unknown scope workflow '${w.name}'...`);
        try {
          await enableMcpForWorkflow(mcp, instanceUrl, apiKey, w, true);
          
          const fullWf = await getWorkflowDetails(mcp, instanceUrl, apiKey, w.id);
          const resolvedFolderId = fullWf.parentFolderId || fullWf.folderId || null;
          const checkInScope = !folderId || (resolvedFolderId === folderId) || (resolvedFolderId && folderPaths[resolvedFolderId] !== undefined);
          
          if (!checkInScope) {
            restoreMcpCache[w.id] = false;
          }
        } catch (err) {
          output.error(`Failed to resolve scope for workflow '${w.name}': ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
  return restoreMcpCache;
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
  for (const [wId, originalVal] of Object.entries(mcpCache)) {
    if (originalVal === false) {
      output.log(`Restoring MCP access to false for workflow ID: ${wId}...`);
      try {
        await enableMcpForWorkflow(mcp, instanceUrl, apiKey, { id: wId }, false);
      } catch (err) {
        output.error(`Failed to restore MCP for workflow ID ${wId}: ${err instanceof Error ? err.message : String(err)}`);
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
    .option('--ref-env <name>', 'override environment for reference workflows')
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

        let envKey = options.env;
        if (!envKey) {
          const envArgIndex = process.argv.indexOf('--env');
          if (envArgIndex !== -1 && envArgIndex + 1 < process.argv.length) {
            envKey = process.argv[envArgIndex + 1];
          } else {
            const envArg = process.argv.find(arg => arg.startsWith('--env='));
            if (envArg) {
              envKey = envArg.split('=')[1];
            }
          }
        }
        if (!envKey) {
          envKey = config?.env || config?.environmentName || 'development';
        }

        const refEnv = options.refEnv || config?.references?.env;
        const isIndependentRefEnv = refEnv && refEnv !== envKey;

        let refMcpCommand = mcpCommand;
        let refAccessToken = accessToken;
        let refApiKey = apiKey;
        let refInstanceUrl = instanceUrl;

        if (isIndependentRefEnv) {
          const globalConfig = loadGlobalConfig();
          const refEnvConfig = globalConfig.environments?.[refEnv] || {};
          refMcpCommand = refEnvConfig.mcpCommand || globalConfig.mcpCommand || 'npx -y n8n-mcp';
          refAccessToken = refEnvConfig.accessToken || globalConfig.accessToken || '';
          refApiKey = refEnvConfig.apiKey || globalConfig.apiKey || '';
          refInstanceUrl = refEnvConfig.instanceUrl || globalConfig.instanceUrl || '';

          if (!refAccessToken) {
            throw new Error(
              `n8n access token is required for reference environment '${refEnv}'. Set N8N_ACCESS_TOKEN in your environment or global config environments.${refEnv}.accessToken.`
            );
          }
          if (!refInstanceUrl) {
            throw new Error(
              `n8n instance URL is required for reference environment '${refEnv}'. Set N8N_INSTANCE_URL in your environment or global config environments.${refEnv}.instanceUrl.`
            );
          }
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
        let hasConflicts = false;

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          let folderPaths: Record<string, string> = {};
          
          const sigHandler = async () => {
            output.log('\nProcess interrupted. Restoring MCP settings...');
            try {
              await restoreMcpSettings(mcp, instanceUrl, apiKey, projectId, mainMcpCache, folderId, folderPaths);
              if (refProjId && !isIndependentRefEnv && refProjId !== projectId) {
                await restoreMcpSettings(mcp, instanceUrl, apiKey, refProjId, refMcpCache);
              }
            } catch (e) {}
            process.exit(1);
          };
          process.on('SIGINT', sigHandler);
          process.on('SIGTERM', sigHandler);

          try {
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

            // 1. Temporarily enable MCP for the main project
            mainMcpCache = await temporarilyEnableMcp(mcp, instanceUrl, apiKey, projectId, folderId, folderPaths, folderCache);

            // 2. Temporarily enable MCP for the reference project if it is configured, in the same environment, and different
            if (refProjId && !isIndependentRefEnv) {
              if (refProjId !== projectId) {
                let refFolderPaths: Record<string, string> = {};
                try {
                  const foldersResponse = await mcp.callToolAndGetJson('search_folders', { projectId: refProjId });
                  const folders = Array.isArray(foldersResponse) ? foldersResponse : (foldersResponse.folders || foldersResponse.data || []);
                  refFolderPaths = buildFolderPaths(folders, refFolderId);
                } catch (e) {}
                refMcpCache = await temporarilyEnableMcp(mcp, instanceUrl, apiKey, refProjId, refFolderId, refFolderPaths, folderCache);
              } else {
                refMcpCache = mainMcpCache;
              }
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
                      output.warn(`Warning: New workflow '${w.name}' (${w.id}) found but its folder mapping is unknown. It will be placed at the root of the workflows directory. Provide a valid database connection URL via --db-url to sync folders.`);
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
                    folderId: wFolderId || undefined,
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
                    folderId: wFolderId || undefined,
                  };
                  unchangedCount++;
                } else {
                  // Scenario C: Hashes differ -> check if local was modified
                  const isLocalModified = stateEntry && stateEntry.contentHash !== localHash;

                  if (isLocalModified && !options.force) {
                    output.warn(`  [CONFLICT] '${relativePath}' has local modifications. Skipping. Use --force to overwrite.`);
                    skippedCount++;
                    hasConflicts = true;
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
                      folderId: wFolderId || undefined,
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

            // Pull references (same environment case)
            if (!options.skipReferences && refProjId && !isIndependentRefEnv) {
              await pullReferences(mcp, config, repoRoot!, folderCache, instanceUrl, apiKey);
            }
          } finally {
            process.off('SIGINT', sigHandler);
            process.off('SIGTERM', sigHandler);

            output.log('Restoring MCP access settings for the project(s)...');
            try {
              await restoreMcpSettings(mcp, instanceUrl, apiKey, projectId, mainMcpCache, folderId, folderPaths);
            } catch (err) {
              output.error(`Failed to restore main project MCP settings: ${err instanceof Error ? err.message : String(err)}`);
            }
            if (refProjId && !isIndependentRefEnv && refProjId !== projectId) {
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

          // Pull references (independent environment case)
          if (!options.skipReferences && refProjId && isIndependentRefEnv) {
            output.log(`Connecting to reference environment '${refEnv}' to pull reference workflows...`);
            await withMcp(refMcpCommand, refAccessToken, async (refMcp) => {
              let refFolderPaths: Record<string, string> = {};
              try {
                try {
                  const foldersResponse = await refMcp.callToolAndGetJson('search_folders', { projectId: refProjId });
                  const folders = Array.isArray(foldersResponse) ? foldersResponse : (foldersResponse.folders || foldersResponse.data || []);
                  refFolderPaths = buildFolderPaths(folders, refFolderId);
                } catch (e) {}
                refMcpCache = await temporarilyEnableMcp(refMcp, refInstanceUrl, refApiKey, refProjId, refFolderId, refFolderPaths, folderCache);
                await pullReferences(refMcp, config, repoRoot!, folderCache, refInstanceUrl, refApiKey);
              } finally {
                output.log(`Restoring MCP access settings for reference project on environment '${refEnv}'...`);
                try {
                  const foldersResponse = await refMcp.callToolAndGetJson('search_folders', { projectId: refProjId });
                  const folders = Array.isArray(foldersResponse) ? foldersResponse : (foldersResponse.folders || foldersResponse.data || []);
                  refFolderPaths = buildFolderPaths(folders, refFolderId);
                } catch (e) {
                  // ignore
                }
                try {
                  await restoreMcpSettings(refMcp, refInstanceUrl, refApiKey, refProjId, refMcpCache, refFolderId, refFolderPaths);
                } catch (err) {
                  output.error(`Failed to restore references project MCP settings on environment '${refEnv}': ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            });
          }
        });

        // Sync credentials with database and check for unconfigured ones
        if (dbUrl) {
          const unconfigured = await syncCredentials(repoRoot, config, dbUrl, localDir);
          if (unconfigured.length > 0) {
            output.warn('\n--- UNCONFIGURED CREDENTIALS DETECTED ---');
            output.warn('The following credentials need to be configured in n8n (direct project links, zero-log):');
            for (const cred of unconfigured) {
              output.warn(`  - Name: "${cred.name}" (Type: ${cred.type})`);
              output.warn(`    Configure at: ${cred.url}`);
            }
            output.warn('----------------------------------------\n');
          }
        }

        output.log('Pull complete summary:');
        output.log(`  - Created: ${createdCount}`);
        output.log(`  - Updated: ${updatedCount}`);
        output.log(`  - Unchanged: ${unchangedCount}`);
        output.log(`  - Skipped/Conflict: ${skippedCount}`);

        if (hasConflicts) {
          process.exit(3);
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

