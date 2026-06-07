import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { getConnectionInfo } from '../config.js';
import { withMcp } from '../mcp-client.js';
import { loadSyncState, saveSyncState, calculateHash, SyncWorkflowEntry } from '../sync-state.js';
import { pullReferences } from '../references.js';
import { generateWorkflowCode, parseWorkflowCodeToBuilder } from '@n8n/workflow-sdk';
import * as output from '../output.js';

export function pullCommand(program: Command) {
  program
    .command('pull')
    .description('Pull workflows from n8n instance and convert them to TypeScript SDK files')
    .option('--force', 'overwrite local modifications without confirmation', false)
    .option('--skip-references', 'skip pulling reference workflows', false)
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

        output.log(`Pulling workflows for project '${config.projectName}'...`);

        const syncState = loadSyncState(repoRoot);
        const activeWorkflowIds = new Set<string>();

        let createdCount = 0;
        let updatedCount = 0;
        let unchangedCount = 0;
        let skippedCount = 0;

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          // 1. Fetch remote workflows list
          const searchResponse = await mcp.callToolAndGetJson('search_workflows', {
            projectId,
            limit: 250,
          });

          const workflows = Array.isArray(searchResponse) ? searchResponse : (searchResponse.workflows || []);
          
          // Filter by folder if configured
          let targetWorkflows = workflows;
          if (folderId) {
            targetWorkflows = workflows.filter((w: any) => w.folderId === folderId);
          }

          output.log(`Found ${targetWorkflows.length} workflows in scope.`);

          const sanitizeFilename = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_');

          for (const w of targetWorkflows) {
            activeWorkflowIds.add(w.id);

            try {
              // 2. Fetch full details of each workflow
              const details = await mcp.callToolAndGetJson('get_workflow_details', {
                id: w.id,
              });

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
              let folderSubdir = '';
              if (details.folderName) {
                folderSubdir = sanitizeFilename(details.folderName);
              } else if (config.folderName) {
                folderSubdir = sanitizeFilename(config.folderName);
              }

              const localWorkflowsDir = path.join(repoRoot, 'n8n', 'workflows');
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
                  folderId: details.folderId,
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
                  folderId: details.folderId,
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
                    folderId: details.folderId,
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
          // We don't delete them from filesystem automatically (safer), but we clean them up from sync-state if they were deleted on remote.
          // Wait, actually, let's keep them in sync-state but mark them, or let's clean them up.
          // If we clean them up from sync-state, n8ncli status/push will see them as untracked new local files.
          for (const [relPath, entry] of Object.entries(syncState.workflows)) {
            if (!activeWorkflowIds.has(entry.id)) {
              output.log(`  [REMOTE DELETED] Workflow '${entry.name}' (${relPath}) was deleted on remote.`);
              delete syncState.workflows[relPath];
            }
          }

          // 7. Save sync state
          syncState.lastSync = new Date().toISOString();
          saveSyncState(repoRoot, syncState);

          // 8. Pull references
          if (!options.skipReferences) {
            await pullReferences(mcp, config, repoRoot);
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
      }
    });
}
