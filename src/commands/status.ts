import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { findRepoRoot, loadConfig, convertLocalJsonWorkflows } from '../config.js';
import { loadSyncState, calculateHash } from '../sync-state.js';
import * as output from '../output.js';

export function statusCommand(program: Command) {
  program
    .command('status')
    .description('Show local changes compared to the last sync state')
    .action(() => {
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

        // Output summary
        if (newFiles.length === 0 && modifiedFiles.length === 0 && deletedFiles.length === 0) {
          output.log('Your branch is up to date with the sync state. No changes to push.');
          return;
        }

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

        const totalChanges = newFiles.length + modifiedFiles.length + deletedFiles.length;
        output.log(`Total: ${totalChanges} changed files (${unchangedFiles.length} unchanged).`);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
