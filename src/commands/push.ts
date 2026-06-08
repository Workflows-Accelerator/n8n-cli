import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import pg from 'pg';
import { getConnectionInfo, buildFolderPaths, convertLocalJsonWorkflows, syncCredentials } from '../config.js';
import { withMcp, McpClient } from '../mcp-client.js';
import { loadSyncState, saveSyncState, calculateHash, SyncWorkflowEntry } from '../sync-state.js';
import { parseWorkflowCodeToBuilder, validateWorkflow } from '@n8n/workflow-sdk';
import * as output from '../output.js';
import { loadStandards, validateWorkflowAgainstStandards } from '../lint-engine.js';

function extractIdFromResponse(response: any): string | null {
  if (!response) return null;
  if (typeof response === 'object') {
    if (response.id) return String(response.id);
    if (response.workflowId) return String(response.workflowId);
    if (response.workflow && response.workflow.id) return String(response.workflow.id);
    if (response.workflowId && typeof response.workflowId === 'string') return response.workflowId;
  }
  
  const str = String(response);
  // Matches "ID: 123" or "id: 'abc'" or similar
  const match = str.match(/(?:ID|id)\s*[:=]\s*["']?([a-zA-Z0-9_-]+)["']?/i) || 
                str.match(/(?:created|updated|workflow)\s+([a-zA-Z0-9_-]+)/i);
  if (match) {
    return match[1];
  }
  return null;
}

async function findWorkflowIdByName(mcp: McpClient, projectId: string, name: string): Promise<string | null> {
  try {
    const searchResult = await mcp.callToolAndGetJson('search_workflows', {
      projectId,
      limit: 200,
    });
    const list = Array.isArray(searchResult) ? searchResult : (searchResult.data || searchResult.workflows || []);
    const matched = list.find((w: any) => w.name === name);
    return matched ? String(matched.id) : null;
  } catch (err) {
    return null;
  }
}

function generateFolderId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function pushCommand(program: Command) {
  program
    .command('push')
    .description('Push local workflow changes to n8n instance')
    .option('--force', 'overwrite remote modifications and bypass conflict checks', false)
    .option('--dry-run', 'simulate changes without executing them', false)
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .option('--api-key <key>', 'override n8n REST API key')
    .option('--url <url>', 'override n8n instance URL')
    .option('--db-url <url>', 'override n8n PostgreSQL database connection URL')
    .option('--env <name>', 'override environment name on run')
    .action(async (options) => {
      let pgClient: any = null;
      let hasConflicts = false;
      try {
        const { mcpCommand, accessToken, config, repoRoot, localDir, dbUrl, apiKey, instanceUrl } = getConnectionInfo(options);
        if (!config || !repoRoot) {
          throw new Error('Project must be initialized. Run `n8ncli init` first.');
        }

        const projectId = config.projectId;
        const folderId = config.folderId;

        output.log(`Pushing local changes for project '${config.projectName}'...`);

        const syncState = loadSyncState(repoRoot, localDir);
        const localWorkflowsDir = path.join(repoRoot, localDir, 'workflows');

        // Convert local json workflows to TS workflows before doing anything
        convertLocalJsonWorkflows(localWorkflowsDir);

        // 1. Scan local .workflow.ts files
        const localFiles = glob.sync('**/*.workflow.ts', { cwd: localWorkflowsDir });
        const localRelativePaths = localFiles.map(f => f.replace(/\\/g, '/')); // Normalize path separators

        const localHashes: Record<string, string> = {};
        const localNames: Record<string, string> = {};
        const localCodes: Record<string, string> = {};
        const localIds: Record<string, string> = {};

        // Parse and validate local files
        let localValidationFailed = false;

        for (const relPath of localRelativePaths) {
          const fullPath = path.join(localWorkflowsDir, relPath);
          const code = fs.readFileSync(fullPath, 'utf-8');
          localCodes[relPath] = code;
          localHashes[relPath] = calculateHash(code);

          try {
            const builder = parseWorkflowCodeToBuilder(code);
            const validation = builder.validate();
            const workflowJson = builder.toJSON();
            localNames[relPath] = workflowJson.name || path.basename(relPath, '.workflow.ts');
            localIds[relPath] = workflowJson.id || '';

            if (validation.errors.length > 0) {
              output.error(`Validation failed for local file '${relPath}':`);
              for (const err of validation.errors) {
                output.error(`  - ${err.message}`);
              }
              localValidationFailed = true;
            }

            try {
              const standards = loadStandards(repoRoot);
              const lintRes = validateWorkflowAgainstStandards(
                workflowJson,
                standards,
                path.join(localDir, 'workflows', relPath).replace(/\\/g, '/')
              );
              if (lintRes.errors.length > 0) {
                output.error(`Lint standards violations for local file '${relPath}':`);
                for (const err of lintRes.errors) {
                  output.error(`  - ${err}`);
                }
                localValidationFailed = true;
              }
            } catch (err) {
              output.error(`Failed to run lint checks for local file '${relPath}': ${err instanceof Error ? err.message : String(err)}`);
              localValidationFailed = true;
            }
          } catch (err) {
            output.error(`Failed to parse local file '${relPath}': ${err instanceof Error ? err.message : String(err)}`);
            localValidationFailed = true;
          }
        }

        if (localValidationFailed && !options.force) {
          throw new Error('Push aborted due to local workflow validation or parsing errors. Fix them or use --force to bypass.');
        }

        // 2. Classify actions
        const newPaths: string[] = [];
        const modifiedPaths: string[] = [];
        const deletedPaths: string[] = [];
        const unchangedPaths: string[] = [];

        // Find new and modified files
        for (const relPath of localRelativePaths) {
          const entry = syncState.workflows[relPath];
          if (!entry) {
            newPaths.push(relPath);
          } else if (entry.contentHash !== localHashes[relPath]) {
            modifiedPaths.push(relPath);
          } else {
            unchangedPaths.push(relPath);
          }
        }

        // Find deleted files
        for (const [relPath, entry] of Object.entries(syncState.workflows)) {
          if (!localRelativePaths.includes(relPath)) {
            deletedPaths.push(relPath);
          }
        }

        // Detect renames (file renamed on disk)
        const renamedPaths: Array<{ oldPath: string; newPath: string; id: string; name: string }> = [];
        const unmatchedNewPaths: string[] = [];
        
        for (const newPath of newPaths) {
          const localId = localIds[newPath];
          const deletedEntryIndex = deletedPaths.findIndex(oldPath => {
            const entry = syncState.workflows[oldPath];
            return entry && entry.id === localId;
          });

          if (deletedEntryIndex !== -1) {
            const oldPath = deletedPaths[deletedEntryIndex];
            const entry = syncState.workflows[oldPath];
            renamedPaths.push({
              oldPath,
              newPath,
              id: entry.id,
              name: localNames[newPath],
            });
            deletedPaths.splice(deletedEntryIndex, 1);
          } else {
            unmatchedNewPaths.push(newPath);
          }
        }
        
        newPaths.length = 0;
        newPaths.push(...unmatchedNewPaths);

        // Scan local folders under localWorkflowsDir
        const localFolders: string[] = [];
        const getLocalSubdirectories = (dir: string, baseDir: string) => {
          try {
            const list = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of list) {
              if (item.isDirectory()) {
                const fullPath = path.join(dir, item.name);
                const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
                localFolders.push(relPath);
                getLocalSubdirectories(fullPath, baseDir);
              }
            }
          } catch (e) {
            // ignore
          }
        };
        if (fs.existsSync(localWorkflowsDir)) {
          getLocalSubdirectories(localWorkflowsDir, localWorkflowsDir);
        }
        localFolders.sort((a, b) => a.split('/').length - b.split('/').length);

        // Database connection and fetching remote folders
        let remoteFolders: any[] = [];
        const folderPathToId: Record<string, string> = {};
        let folderPaths: Record<string, string> = {};

        if (dbUrl) {
          try {
            const pgModule = pg as any;
            const ClientClass = pgModule.Client || pgModule.default?.Client || pgModule;
            pgClient = new ClientClass({
              connectionString: dbUrl,
              ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false')) ? false : { rejectUnauthorized: false }
            });
            await pgClient.connect();
            
            const res = await pgClient.query(
              'SELECT id, name, "parentFolderId" FROM folder WHERE "projectId" = $1;',
              [projectId]
            );
            remoteFolders = res.rows;
            folderPaths = buildFolderPaths(remoteFolders, folderId);
            for (const [fId, fPath] of Object.entries(folderPaths)) {
              folderPathToId[fPath.toLowerCase()] = fId;
            }
          } catch (err) {
            output.warn(`Failed to connect to database for folder sync: ${err instanceof Error ? err.message : String(err)}. Skipping database folder sync.`);
            pgClient = null;
          }
        }

        // Detect folder renames/moves from workflow renames
        const folderRenames = new Map<string, { newPath: string; newName: string; parentPath: string }>();
        for (const rename of renamedPaths) {
          const oldFolderPart = path.dirname(rename.oldPath).replace(/\\/g, '/');
          const newFolderPart = path.dirname(rename.newPath).replace(/\\/g, '/');
          
          if (oldFolderPart !== newFolderPart) {
            const oldWfEntry = syncState.workflows[rename.oldPath];
            if (oldWfEntry && oldWfEntry.folderId && oldWfEntry.folderId !== folderId) {
              const oldFolderId = oldWfEntry.folderId;
              const newPathLower = newFolderPart.toLowerCase();
              if (newFolderPart && newFolderPart !== '.' && !folderPathToId[newPathLower] && !folderRenames.has(oldFolderId)) {
                // Check if all workflows currently active in oldFolderId are moved to the same destination
                const oldFolderWorkflows = Object.values(syncState.workflows).filter(w => w.folderId === oldFolderId);
                const activeOldFolderWorkflows = oldFolderWorkflows.filter(w => 
                  localRelativePaths.some(p => {
                    const entry = syncState.workflows[p];
                    return entry && entry.id === w.id;
                  })
                );
                const movedToNewFolder = renamedPaths.filter(r => 
                  oldFolderWorkflows.some(w => w.id === r.id) && 
                  path.dirname(r.newPath).replace(/\\/g, '/') === newFolderPart
                );

                if (activeOldFolderWorkflows.length > 0 && movedToNewFolder.length === activeOldFolderWorkflows.length) {
                  const newName = path.basename(newFolderPart);
                  const parentPath = path.dirname(newFolderPart).replace(/\\/g, '/');
                  folderRenames.set(oldFolderId, { newPath: newFolderPart, newName, parentPath });
                }
              }
            }
          }
        }

        // Calculate new folders to create
        const newFoldersToCreate: Array<{ name: string; path: string; parentId: string | null }> = [];
        const tempFolderPathToId = { ...folderPathToId };
        
        for (const [fId, update] of folderRenames.entries()) {
          tempFolderPathToId[update.newPath.toLowerCase()] = fId;
        }

        for (const localFolder of localFolders) {
          if (!tempFolderPathToId[localFolder.toLowerCase()]) {
            const folderName = path.basename(localFolder);
            const parentPath = path.dirname(localFolder).replace(/\\/g, '/');
            let parentFolderDbId: string | null = folderId || null;
            if (parentPath && parentPath !== '.') {
              parentFolderDbId = tempFolderPathToId[parentPath.toLowerCase()] || folderId || null;
            }
            newFoldersToCreate.push({ name: folderName, path: localFolder, parentId: parentFolderDbId });
            tempFolderPathToId[localFolder.toLowerCase()] = 'simulated_new_id';
          }
        }

        // Calculate folder prunes
        const activeFolderIds = new Set<string>();
        for (const localFolder of localFolders) {
          const id = tempFolderPathToId[localFolder.toLowerCase()];
          if (id && id !== 'simulated_new_id') activeFolderIds.add(id);
        }

        const pruneCandidates = remoteFolders.filter((f: any) => 
          f.id !== folderId && 
          folderPaths[f.id] !== undefined && 
          (syncState.folders || []).includes(f.id) && 
          !activeFolderIds.has(f.id)
        );

        if (pruneCandidates.length > 0) {
          const folderDepths = new Map<string, number>();
          const getFolderDepth = (id: string): number => {
            if (folderDepths.has(id)) return folderDepths.get(id)!;
            const f = remoteFolders.find((r: any) => r.id === id);
            if (!f || !f.parentFolderId || f.parentFolderId === folderId) {
              folderDepths.set(id, 0);
              return 0;
            }
            const d = getFolderDepth(f.parentFolderId) + 1;
            folderDepths.set(id, d);
            return d;
          };
          pruneCandidates.sort((a: any, b: any) => getFolderDepth(b.id) - getFolderDepth(a.id));
        }

        // Check for any changes (workflows OR folders)
        const hasWorkflowChanges = newPaths.length > 0 || modifiedPaths.length > 0 || deletedPaths.length > 0 || renamedPaths.length > 0;
        const hasFolderChanges = folderRenames.size > 0 || newFoldersToCreate.length > 0 || pruneCandidates.length > 0;

        if (!hasWorkflowChanges && !hasFolderChanges) {
          output.log('Everything is up-to-date.');
          return;
        }

        // Print Plan
        output.log('Plan:');
        if (newPaths.length > 0) {
          output.log('  New Workflows:');
          newPaths.forEach(p => output.log(`    + ${p}`));
        }
        if (renamedPaths.length > 0) {
          output.log('  Renamed Workflows:');
          renamedPaths.forEach(r => output.log(`    -> ${r.oldPath} to ${r.newPath}`));
        }
        if (modifiedPaths.length > 0) {
          output.log('  Modified Workflows:');
          modifiedPaths.forEach(p => output.log(`    ~ ${p}`));
        }
        if (deletedPaths.length > 0) {
          output.log('  Deleted (Archive) Workflows:');
          deletedPaths.forEach(p => output.log(`    - ${p}`));
        }
        
        if (hasFolderChanges) {
          output.log('  Folder Operations:');
          for (const [fId, update] of folderRenames.entries()) {
            let newParentId = folderId || null;
            if (update.parentPath && update.parentPath !== '.') {
              newParentId = tempFolderPathToId[update.parentPath.toLowerCase()] || folderId || null;
            }
            output.log(`    ~ Rename folder ID ${fId} to '${update.newName}' (parent: ${newParentId || 'root'})`);
          }
          for (const newFolder of newFoldersToCreate) {
            output.log(`    + Create folder: '${newFolder.name}' (path: ${newFolder.path}, parent: ${newFolder.parentId || 'root'})`);
          }
          for (const prune of pruneCandidates) {
            output.log(`    - Delete folder: '${prune.name}' (ID: ${prune.id})`);
          }
        }

        // If dry-run, exit successfully
        if (options.dryRun) {
          output.log('\n[Dry Run] Push simulated successfully.');
          return;
        }

        // Execute Folder Renames and Creations in DB (Actual Run)
        if (pgClient) {
          // Folder renames
          for (const [fId, update] of folderRenames.entries()) {
            let newParentId: string | null = folderId || null;
            if (update.parentPath && update.parentPath !== '.') {
              newParentId = folderPathToId[update.parentPath.toLowerCase()] || folderId || null;
            }
            output.log(`Renaming folder in database: ID ${fId} to '${update.newName}' (parent: ${newParentId || 'root'})...`);
            try {
              await pgClient.query(
                'UPDATE folder SET name = $1, "parentFolderId" = $2, "updatedAt" = NOW() WHERE id = $3;',
                [update.newName, newParentId, fId]
              );
            } catch (err) {
              output.error(`Failed to rename folder ${fId}: ${err instanceof Error ? err.message : String(err)}`);
            }
            folderPathToId[update.newPath.toLowerCase()] = fId;
          }

          // Folder creations
          for (const newFolder of newFoldersToCreate) {
            const newFId = generateFolderId();
            let parentDbId: string | null = folderId || null;
            if (newFolder.path) {
              const parentPath = path.dirname(newFolder.path).replace(/\\/g, '/');
              if (parentPath && parentPath !== '.') {
                parentDbId = folderPathToId[parentPath.toLowerCase()] || folderId || null;
              }
            }
            output.log(`Creating folder in database: '${newFolder.name}' (parent: ${parentDbId || 'root'}) with ID ${newFId}...`);
            try {
              await pgClient.query(
                'INSERT INTO folder (id, name, "parentFolderId", "projectId", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, NOW(), NOW());',
                [newFId, newFolder.name, parentDbId, projectId]
              );
            } catch (err) {
              output.error(`Failed to create folder '${newFolder.path}': ${err instanceof Error ? err.message : String(err)}`);
            }
            folderPathToId[newFolder.path.toLowerCase()] = newFId;
            activeFolderIds.add(newFId);
          }
        }

        // Sync credentials with database first so placeholders exist before workflows are pushed
        let unconfiguredCredentials: any[] = [];
        if (dbUrl) {
          unconfiguredCredentials = await syncCredentials(repoRoot, config, dbUrl, localDir);
        }

        // 10. Connect to MCP and execute actions
        await withMcp(mcpCommand, accessToken, async (mcp) => {
          // A. Handle Deleted Workflows
          for (const relPath of deletedPaths) {
            const entry = syncState.workflows[relPath];
            output.log(`Archiving workflow: ${entry.name} (${entry.id})...`);
            try {
              await mcp.callTool('archive_workflow', {
                workflowId: entry.id,
              });
              delete syncState.workflows[relPath];
            } catch (err) {
              output.error(`Failed to archive workflow '${entry.name}': ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // Fallback to MCP folders fetch if database did not build the path mapping
          if (Object.keys(folderPathToId).length === 0 && projectId) {
            try {
              const folders = await mcp.callToolAndGetJson('search_folders', { projectId });
              const folderList = Array.isArray(folders) ? folders : (folders.folders || folders.data || []);
              const paths = buildFolderPaths(folderList, folderId);
              for (const [fId, fPath] of Object.entries(paths)) {
                folderPathToId[fPath.toLowerCase()] = fId;
              }
            } catch (err) {
              // ignore
            }
          }

          // B. Handle Renamed or Moved Workflows
          for (const rename of renamedPaths) {
            const folderPart = path.dirname(rename.newPath).replace(/\\/g, '/');
            let newFolderId = folderId;
            if (folderPart && folderPart !== '.') {
              newFolderId = folderPathToId[folderPart.toLowerCase()] || folderId;
            }

            const oldEntry = syncState.workflows[rename.oldPath];
            const oldFolderId = oldEntry ? oldEntry.folderId : undefined;
            const isMove = oldFolderId !== undefined && oldFolderId !== newFolderId;

            if (isMove) {
              output.log(`Moving remote workflow: ${rename.name} (from folder ${oldFolderId || 'root'} to ${newFolderId || 'root'})...`);
              try {
                const code = localCodes[rename.newPath];
                if (apiKey && instanceUrl) {
                  const res = await fetch(`${instanceUrl}/api/v1/workflows/${rename.id}`, {
                    method: 'PUT',
                    headers: {
                      'X-N8N-API-KEY': apiKey,
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      parentFolderId: newFolderId || null,
                    }),
                  });
                  if (!res.ok) {
                    throw new Error(`Failed to update folder relationship via REST API: ${res.statusText}`);
                  }
                  
                  await mcp.callTool('update_workflow', {
                    workflowId: rename.id,
                    code,
                    name: rename.name,
                  });

                  delete syncState.workflows[rename.oldPath];
                  syncState.workflows[rename.newPath] = {
                    id: rename.id,
                    name: rename.name,
                    localPath: rename.newPath,
                    contentHash: localHashes[rename.newPath],
                    remoteUpdatedAt: new Date().toISOString(),
                    folderId: newFolderId,
                  };
                  output.log(`  [MOVED] ${rename.oldPath} -> ${rename.newPath} (ID: ${rename.id})`);
                } else {
                  throw new Error('REST API key or instance URL is missing. Cannot perform workflow move.');
                }
              } catch (err) {
                output.error(`Failed to move workflow '${rename.name}': ${err instanceof Error ? err.message : String(err)}`);
              }
            } else {
              output.log(`Renaming remote workflow: ${rename.name} (${rename.id})...`);
              try {
                const code = localCodes[rename.newPath];
                await mcp.callTool('update_workflow', {
                  workflowId: rename.id,
                  code,
                  name: rename.name,
                });

                delete syncState.workflows[rename.oldPath];
                syncState.workflows[rename.newPath] = {
                  ...oldEntry,
                  name: rename.name,
                  localPath: rename.newPath,
                  contentHash: localHashes[rename.newPath],
                  remoteUpdatedAt: new Date().toISOString(),
                  folderId: oldFolderId,
                };
                output.log(`  [RENAMED] ${rename.oldPath} -> ${rename.newPath}`);
              } catch (err) {
                output.error(`Failed to rename workflow '${rename.name}': ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }

          // C. Handle New Workflows
          for (const relPath of newPaths) {
            const name = localNames[relPath];
            output.log(`Creating new workflow: ${name}...`);

            const folderPart = path.dirname(relPath).replace(/\\/g, '/');
            let targetFolderId = folderId;
            if (folderPart && folderPart !== '.') {
              const resolvedId = folderPathToId[folderPart.toLowerCase()];
              if (resolvedId) {
                targetFolderId = resolvedId;
              } else {
                output.warn(`Folder path '${folderPart}' not found on remote. Creating workflow at project root.`);
              }
            }

            try {
              const code = localCodes[relPath];
              const response = await mcp.callTool('create_workflow_from_code', {
                code,
                projectId,
                folderId: targetFolderId,
              });

              let newId = extractIdFromResponse(response);
              if (!newId) {
                newId = await findWorkflowIdByName(mcp, projectId, name);
              }

              if (!newId) {
                throw new Error('Could not retrieve new workflow ID from creation response.');
              }

              syncState.workflows[relPath] = {
                id: newId,
                name,
                localPath: relPath,
                contentHash: localHashes[relPath],
                remoteUpdatedAt: new Date().toISOString(),
                folderId: targetFolderId,
              };
              output.log(`  [CREATED] ${relPath} (ID: ${newId})`);
            } catch (err) {
              output.error(`Failed to create workflow '${name}': ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // D. Handle Modified Workflows
          for (const relPath of modifiedPaths) {
            const entry = syncState.workflows[relPath];
            const name = localNames[relPath];
            output.log(`Updating workflow: ${name} (${entry.id})...`);

            try {
              let conflict = false;
              if (!options.force) {
                try {
                  const remoteDetailsRes = await mcp.callToolAndGetJson('get_workflow_details', {
                    workflowId: entry.id,
                    id: entry.id,
                  });
                  const remoteDetails = remoteDetailsRes.workflow || remoteDetailsRes;
                  
                  if (remoteDetails.updatedAt && entry.remoteUpdatedAt !== remoteDetails.updatedAt) {
                    conflict = true;
                  }
                } catch (e) {
                  // ignore
                }
              }

              if (conflict) {
                output.warn(`  [CONFLICT] Workflow '${name}' has been modified on remote since last pull. Skipping. Use --force to overwrite remote changes.`);
                hasConflicts = true;
                continue;
              }

              const code = localCodes[relPath];
              await mcp.callTool('update_workflow', {
                workflowId: entry.id,
                code,
                name,
              });

              let finalRelPath = relPath;
              if (entry.name !== name) {
                const folderPart = path.dirname(relPath);
                const sanitizeFilename = (n: string) => n.replace(/[\\/:*?"<>|]/g, '_');
                const newFilename = `${sanitizeFilename(name)}.workflow.ts`;
                const newRelPath = folderPart && folderPart !== '.' ? `${folderPart}/${newFilename}` : newFilename;
                
                const oldFullPath = path.join(localWorkflowsDir, relPath);
                const newFullPath = path.join(localWorkflowsDir, newRelPath);
                
                if (oldFullPath !== newFullPath && !fs.existsSync(newFullPath)) {
                  output.log(`  Renaming local file: ${relPath} -> ${newRelPath}`);
                  fs.renameSync(oldFullPath, newFullPath);
                  delete syncState.workflows[relPath];
                  finalRelPath = newRelPath;
                }
              }

              syncState.workflows[finalRelPath] = {
                ...entry,
                name,
                localPath: finalRelPath,
                contentHash: localHashes[relPath],
                remoteUpdatedAt: new Date().toISOString(),
              };
              output.log(`  [UPDATED] ${finalRelPath}`);
            } catch (err) {
              output.error(`Failed to update workflow '${name}': ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // Execute folder pruning in database (Actual Run)
          if (pgClient && pruneCandidates.length > 0) {
            for (const candidate of pruneCandidates) {
              output.log(`Pruning unused folder from database: '${candidate.name}' (ID: ${candidate.id})...`);
              try {
                await pgClient.query('DELETE FROM folder WHERE id = $1;', [candidate.id]);
                activeFolderIds.delete(candidate.id);
              } catch (err) {
                output.error(`Failed to prune folder '${candidate.name}' (ID: ${candidate.id}): ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }

          // Save final sync state
          syncState.lastSync = new Date().toISOString();
          syncState.folders = Array.from(activeFolderIds);
          saveSyncState(repoRoot, syncState, localDir);
        });

        if (dbUrl && unconfiguredCredentials.length > 0) {
          output.warn('\n--- UNCONFIGURED CREDENTIALS DETECTED ---');
          output.warn('The following credentials need to be configured in n8n (direct project links, zero-log):');
          for (const cred of unconfiguredCredentials) {
            output.warn(`  - Name: "${cred.name}" (Type: ${cred.type})`);
            output.warn(`    Configure at: ${cred.url}`);
          }
          output.warn('----------------------------------------\n');
        }

        output.log('Push complete.');
        if (hasConflicts) {
          process.exit(3);
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        if (pgClient) {
          try {
            await pgClient.end();
          } catch (e) {
            // ignore
          }
        }
      }
    });
}
