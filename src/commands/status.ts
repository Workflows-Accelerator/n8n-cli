import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { findRepoRoot, loadConfig, convertLocalJsonWorkflows, loadUnconfiguredCredsCache, getConnectionInfo, fetchWorkflowsPaginated } from '../config.js';
import { loadSyncState, calculateHash } from '../sync-state.js';
import * as output from '../output.js';

export function statusCommand(program: Command) {
  program
    .command('status')
    .description('Show local changes compared to the last sync state')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .option('--api-key <key>', 'override n8n REST API key')
    .option('--url <url>', 'override n8n instance URL')
    .option('--env <name>', 'override environment name')
    .action(async (options) => {
      try {
        const repoRoot = findRepoRoot();
        if (!repoRoot) {
          throw new Error('Project must be initialized. Run `n8ncli init` first.');
        }

        const config = loadConfig(repoRoot);
        const localDir = config.localDir || 'n8n';

        const syncState = loadSyncState(repoRoot, localDir);
        const workflowsDir = path.join(repoRoot, localDir, 'workflows');

        convertLocalJsonWorkflows(workflowsDir);

        if (!fs.existsSync(workflowsDir)) {
          output.log('No workflows directory found. Run `n8ncli pull` first.');
          return;
        }

        // 1. Scan local workflow files
        const localFiles = glob.sync('**/*.workflow.ts', { cwd: workflowsDir });
        const localRelativePaths = localFiles.map(f => f.replace(/\\/g, '/'));

        const newFiles: string[] = [];
        const modifiedFiles: string[] = [];
        const deletedFiles: string[] = [];
        const unchangedFiles: string[] = [];

        // Check new and modified
        for (const relPath of localRelativePaths) {
          const entry = syncState.workflows[relPath];
          if (!entry) {
            newFiles.push(relPath);
          } else {
            const fullPath = path.join(workflowsDir, relPath);
            const content = fs.readFileSync(fullPath, 'utf-8');
            const currentHash = calculateHash(content);

            if (entry.contentHash !== currentHash) {
              modifiedFiles.push(relPath);
            } else {
              unchangedFiles.push(relPath);
            }
          }
        }

        // Check deleted
        for (const [relPath, entry] of Object.entries(syncState.workflows)) {
          if (!localRelativePaths.includes(relPath)) {
            deletedFiles.push(relPath);
          }
        }

        // Check remote-only workflows
        let remoteOnlyWorkflows: any[] = [];
        try {
          const { config: connConfig, instanceUrl, apiKey } = getConnectionInfo(options);
          if (connConfig && instanceUrl && apiKey) {
            const headers = {
              'X-N8N-API-KEY': apiKey,
              'Content-Type': 'application/json',
            };
            const remoteWorkflows = await fetchWorkflowsPaginated(instanceUrl, connConfig.projectId, headers);
            
            const inScopeFolderIds = new Set(syncState.folders || []);
            const activeLocalIds = new Set(Object.values(syncState.workflows).map(w => w.id));

            for (const rw of remoteWorkflows) {
              if (rw.isArchived) continue;
              
              const parentFolderId = rw.parentFolderId || rw.folderId || null;
              const isInScope = !connConfig.folderId || (parentFolderId === connConfig.folderId) || (parentFolderId && inScopeFolderIds.has(parentFolderId));
              if (!isInScope) continue;

              if (!activeLocalIds.has(rw.id)) {
                remoteOnlyWorkflows.push(rw);
              }
            }
          }
        } catch (err) {
          // Gracefully skip remote-only checks when offline or not configured
          output.debug(`Could not check for remote-only workflows: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (output.getJsonMode()) {
          console.log(JSON.stringify({
            status: (newFiles.length === 0 && modifiedFiles.length === 0 && deletedFiles.length === 0 && remoteOnlyWorkflows.length === 0) ? 'up-to-date' : 'diverged',
            untracked: newFiles,
            modified: modifiedFiles,
            deleted: deletedFiles,
            remoteOnly: remoteOnlyWorkflows.map(w => ({ id: w.id, name: w.name, parentFolderId: w.parentFolderId })),
            unchangedCount: unchangedFiles.length
          }, null, 2));
          return;
        }

        // Output summary
        if (newFiles.length === 0 && modifiedFiles.length === 0 && deletedFiles.length === 0 && remoteOnlyWorkflows.length === 0) {
          output.log('Your branch is up to date with the sync state. No changes to push or pull.');
          return;
        }

        if (newFiles.length > 0 || modifiedFiles.length > 0 || deletedFiles.length > 0) {
          output.log('Changes not yet pushed:');
          output.log('  (use "n8ncli push" to sync with n8n instance)\n');

          if (newFiles.length > 0) {
            output.log('Untracked (new local workflows):');
            newFiles.forEach(f => output.log(`  + ${f}`));
            output.log('');
          }

          if (modifiedFiles.length > 0) {
            output.log('Modified locally (needs push):');
            modifiedFiles.forEach(f => output.log(`  ~ ${f}`));
            output.log('');
          }

          if (deletedFiles.length > 0) {
            output.log('Deleted locally (will archive on push):');
            deletedFiles.forEach(f => output.log(`  - ${f}`));
            output.log('');
          }
        }

        if (remoteOnlyWorkflows.length > 0) {
          output.log('Remote-only (exist on remote, missing locally):');
          output.log('  (use "n8ncli pull" to download them)\n');
          remoteOnlyWorkflows.forEach(w => output.log(`  * ${w.name} (ID: ${w.id})`));
          output.log('');
        }

        const totalChanges = newFiles.length + modifiedFiles.length + deletedFiles.length + remoteOnlyWorkflows.length;
        output.log(`Total: ${totalChanges} changed workflows (${unchangedFiles.length} unchanged).`);

        // Load and show unconfigured credentials from cache (local-only check)
        const unconfigured = loadUnconfiguredCredsCache(repoRoot, localDir);
        if (unconfigured.length > 0) {
          output.warn('\n--- UNCONFIGURED CREDENTIALS DETECTED ---');
          output.warn('The following credentials need to be configured in n8n (direct project links, zero-log):');
          for (const cred of unconfigured) {
            output.warn(`  - Name: "${cred.name}" (Type: ${cred.type})`);
            output.warn(`    Configure at: ${cred.url}`);
          }
          output.warn('----------------------------------------\n');
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
