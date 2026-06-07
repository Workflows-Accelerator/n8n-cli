import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { getConnectionInfo, buildFolderPaths } from '../config.js';
import { withMcp, McpClient } from '../mcp-client.js';
import { loadSyncState, saveSyncState, calculateHash, SyncWorkflowEntry } from '../sync-state.js';
import { parseWorkflowCodeToBuilder, validateWorkflow } from '@n8n/workflow-sdk';
import * as output from '../output.js';

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

export function pushCommand(program: Command) {
  program
    .command('push')
    .description('Push local workflow changes to n8n instance')
    .option('--force', 'overwrite remote modifications and bypass conflict checks', false)
    .option('--dry-run', 'simulate changes without executing them', false)
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (options) => {
      try {
        const { mcpCommand, accessToken, config, repoRoot } = getConnectionInfo(options);
        if (!config || !repoRoot) {
          throw new Error('Project must be initialized. Run `n8ncli init` first.');
        }

        const projectId = config.projectId;
        const folderId = config.folderId;

        output.log(`Pushing local changes for project '${config.projectName}'...`);

        const syncState = loadSyncState(repoRoot);
        const localWorkflowsDir = path.join(repoRoot, 'n8n', 'workflows');

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
            localIds[relPath] = workflowJson.id;

            if (validation.errors.length > 0) {
              output.error(`Validation failed for local file '${relPath}':`);
              for (const err of validation.errors) {
                output.error(`  - ${err.message}`);
              }
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

        if (newPaths.length === 0 && modifiedPaths.length === 0 && deletedPaths.length === 0 && renamedPaths.length === 0) {
          output.log('Everything is up-to-date.');
          return;
        }

        output.log('Plan:');
        if (newPaths.length > 0) {
          output.log('  New:');
          newPaths.forEach(p => output.log(`    + ${p}`));
        }
        if (renamedPaths.length > 0) {
          output.log('  Renamed:');
          renamedPaths.forEach(r => output.log(`    -> ${r.oldPath} to ${r.newPath}`));
        }
        if (modifiedPaths.length > 0) {
          output.log('  Modified:');
          modifiedPaths.forEach(p => output.log(`    ~ ${p}`));
        }
        if (deletedPaths.length > 0) {
          output.log('  Deleted (Archive):');
          deletedPaths.forEach(p => output.log(`    - ${p}`));
        }

        if (options.dryRun) {
          output.log('\n[Dry Run] Push simulated successfully.');
          return;
        }

        // 3. Connect to MCP and execute actions
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

          // Fetch folder mapping to resolve folder ID
          let folderPaths: Record<string, string> = {};
          const folderPathToId: Record<string, string> = {};
          if (projectId) {
            try {
              const folders = await mcp.callToolAndGetJson('search_folders', { projectId });
              const folderList = Array.isArray(folders) ? folders : (folders.folders || folders.data || []);
              folderPaths = buildFolderPaths(folderList, folderId);
              for (const [fId, fPath] of Object.entries(folderPaths)) {
                folderPathToId[fPath.toLowerCase()] = fId;
              }
            } catch (err) {
              // ignore
            }
          }

          // B. Handle Renamed or Moved Workflows (file renamed/moved on disk first)
          for (const rename of renamedPaths) {
            const folderPart = path.dirname(rename.newPath).replace(/\\/g, '/');
            let newFolderId = folderId; // default
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
                const response = await mcp.callTool('create_workflow_from_code', {
                  code,
                  projectId,
                  folderId: newFolderId,
                });

                let newId = extractIdFromResponse(response);
                if (!newId) {
                  newId = await findWorkflowIdByName(mcp, projectId, rename.name);
                }

                if (!newId) {
                  throw new Error('Could not retrieve new workflow ID from creation response during move.');
                }

                // Archive the old workflow ID on n8n
                output.log(`Archiving old workflow ${rename.id}...`);
                await mcp.callTool('archive_workflow', {
                  workflowId: rename.id,
                });

                // Rewrite the local .workflow.ts file with the new workflow ID!
                const fullPath = path.join(localWorkflowsDir, rename.newPath);
                const updatedCode = code.replace(
                  /(workflow\(\s*['"])[a-zA-Z0-9_-]+(['"])/,
                  `$1${newId}$2`
                );
                fs.writeFileSync(fullPath, updatedCode, 'utf-8');

                delete syncState.workflows[rename.oldPath];
                syncState.workflows[rename.newPath] = {
                  id: newId,
                  name: rename.name,
                  localPath: rename.newPath,
                  contentHash: calculateHash(updatedCode),
                  remoteUpdatedAt: new Date().toISOString(),
                  folderId: newFolderId,
                };
                output.log(`  [MOVED] ${rename.oldPath} -> ${rename.newPath} (New ID: ${newId})`);
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

            // Resolve folder ID from path prefix
            const folderPart = path.dirname(relPath).replace(/\\/g, '/');
            let targetFolderId = folderId; // default to configuration folder ID
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
                // Try fallback search by name
                newId = await findWorkflowIdByName(mcp, projectId, name);
              }

              if (!newId) {
                throw new Error('Could not retrieve new workflow ID from creation response.');
              }

              // Update sync state
              syncState.workflows[relPath] = {
                id: newId,
                name,
                localPath: relPath,
                contentHash: localHashes[relPath],
                remoteUpdatedAt: new Date().toISOString(), // Will be updated on next pull
                folderId: targetFolderId,
              };
              output.log(`  [CREATED] ${relPath} (ID: ${newId})`);
            } catch (err) {
              output.error(`Failed to create workflow '${name}': ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // D. Handle Modified Workflows (includes in-code renames)
          for (const relPath of modifiedPaths) {
            const entry = syncState.workflows[relPath];
            const name = localNames[relPath];
            output.log(`Updating workflow: ${name} (${entry.id})...`);

            try {
              // Fetch remote details to check for conflicts
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
                  // ignore get details failure
                }
              }

              if (conflict) {
                output.warn(`  [CONFLICT] Workflow '${name}' has been modified on remote since last pull. Skipping. Use --force to overwrite remote changes.`);
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

              // Update sync entry
              syncState.workflows[finalRelPath] = {
                ...entry,
                name,
                localPath: finalRelPath,
                contentHash: localHashes[relPath],
                remoteUpdatedAt: new Date().toISOString(), // Will be updated on next pull
              };
              output.log(`  [UPDATED] ${finalRelPath}`);
            } catch (err) {
              output.error(`Failed to update workflow '${name}': ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // Save final sync state
          syncState.lastSync = new Date().toISOString();
          saveSyncState(repoRoot, syncState);
        });

        output.log('Push complete.');
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
