import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { getConnectionInfo, convertLocalJsonWorkflows, getWorkflowDetails } from '../config.js';
import { withMcp } from '../mcp-client.js';
import { loadSyncState, isTargetScoped } from '../sync-state.js';
import { generateWorkflowCode } from '@n8n/workflow-sdk';
import * as output from '../output.js';

export function computeLcs(orig: string[], mod: string[]): Int32Array {
  const m = orig.length;
  const n = mod.length;
  const dp = new Int32Array((m + 1) * (n + 1));

  for (let i = 1; i <= m; i++) {
    const rowOffset = i * (n + 1);
    const prevRowOffset = (i - 1) * (n + 1);
    for (let j = 1; j <= n; j++) {
      if (orig[i - 1] === mod[j - 1]) {
        dp[rowOffset + j] = dp[prevRowOffset + j - 1] + 1;
      } else {
        dp[rowOffset + j] = Math.max(dp[prevRowOffset + j], dp[rowOffset + j - 1]);
      }
    }
  }
  return dp;
}

export function printDiff(orig: string[], mod: string[]) {
  const dp = computeLcs(orig, mod);
  let i = orig.length;
  let j = mod.length;
  const n = mod.length;
  const diffLines: string[] = [];

  while (i > 0 || j > 0) {
    const rowOffset = i * (n + 1);
    const prevRowOffset = (i - 1) * (n + 1);
    if (i > 0 && j > 0 && orig[i - 1] === mod[j - 1]) {
      diffLines.push(`  ${orig[i - 1]}`);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[rowOffset + j - 1] >= dp[prevRowOffset + j])) {
      diffLines.push(`\x1b[32m+ ${mod[j - 1]}\x1b[0m`);
      j--;
    } else if (i > 0 && (j === 0 || dp[rowOffset + j - 1] < dp[prevRowOffset + j])) {
      diffLines.push(`\x1b[31m- ${orig[i - 1]}\x1b[0m`);
      i--;
    }
  }

  diffLines.reverse();
  diffLines.forEach(line => console.log(line));
}

export function stripPositions(content: string): string {
  // Replace ", position: [x, y]" (including scientific notation like 2e-14)
  let cleaned = content.replace(/,\s*position:\s*\[\s*-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\s*,\s*-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\s*\]/g, '');
  // Also replace "position: [x, y],"
  cleaned = cleaned.replace(/position:\s*\[\s*-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\s*,\s*-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\s*\]\s*,?/g, '');
  // Replace sticky note width and height
  cleaned = cleaned.replace(/,\s*width:\s*\d+/g, '');
  cleaned = cleaned.replace(/width:\s*\d+\s*,?/g, '');
  cleaned = cleaned.replace(/,\s*height:\s*\d+/g, '');
  cleaned = cleaned.replace(/height:\s*\d+\s*,?/g, '');
  return cleaned;
}

export function showConflictDiff(localPath: string, baseCode: string, localCode: string, remoteCode: string) {
  output.warn(`\n======================================================================`);
  output.warn(`CONFLICT DETAILS FOR WORKFLOW: ${localPath}`);
  output.warn(`======================================================================`);
  
  const baseLines = baseCode.replace(/\r\n/g, '\n').split('\n');
  const remoteLines = remoteCode.replace(/\r\n/g, '\n').split('\n');
  const localLines = localCode.replace(/\r\n/g, '\n').split('\n');
  
  console.log(`\n--- 1. CHANGES MADE REMOTELY (Cache Base -> Remote) ---`);
  printDiff(baseLines, remoteLines);
  
  console.log(`\n--- 2. CHANGES MADE LOCALLY (Cache Base -> Local) ---`);
  printDiff(baseLines, localLines);
  output.warn(`======================================================================\n`);
}

export interface WorkflowDiffResult {
  file: string;
  id?: string;
  status: 'modified' | 'identical' | 'untracked' | 'error';
  error?: string;
}

export function diffCommand(program: Command) {
  program
    .command('diff [target]')
    .description('Show code differences between local workflow files and remote versions in n8n (optional target workflow file, ID, or folder path)')
    .option('--all', 'explicitly target all workflows in workspace', false)
    .option('--summary', 'only show a summary list of diff statuses without full line diffs', false)
    .option('--semantic', 'ignore coordinate/layout changes in diff output', false)
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .option('--api-key <key>', 'override n8n REST API key')
    .option('--url <url>', 'override n8n instance URL')
    .option('--env <name>', 'override environment name')
    .option('--json', 'output structured JSON format')
    .action(async (targetArg, options) => {
      try {
        const { mcpCommand, accessToken, apiKey, instanceUrl, repoRoot, localDir } = getConnectionInfo(options);
        if (!repoRoot) {
          throw new Error('Project must be initialized. Run `n8ncli init` first.');
        }

        const workflowsDir = path.join(repoRoot, localDir, 'workflows');
        convertLocalJsonWorkflows(workflowsDir);

        if (!fs.existsSync(workflowsDir)) {
          throw new Error(`Workflows directory not found at ${workflowsDir}`);
        }

        const syncState = loadSyncState(repoRoot, localDir);
        const localFiles = glob.sync('**/*.workflow.ts', { cwd: workflowsDir });
        const localRelativePaths = localFiles.map(f => f.replace(/\\/g, '/'));

        // Match workflows against target filter
        const matchedRelativePaths = localRelativePaths.filter(relPath => {
          const entry = syncState.workflows[relPath];
          return isTargetScoped(relPath, entry?.id, entry?.name, targetArg);
        });

        if (matchedRelativePaths.length === 0) {
          if (targetArg) {
            output.warn(`No local workflows matched target '${targetArg}'.`);
          } else {
            output.log('No local workflow files found to diff.');
          }
          return;
        }

        if (targetArg && targetArg.trim() !== '' && !output.getJsonMode()) {
          output.log(`Diffing workflows matching target '${targetArg}'...`);
        } else if (!output.getJsonMode()) {
          output.log(`Diffing ${matchedRelativePaths.length} workflow file(s) against n8n...`);
        }

        const results: WorkflowDiffResult[] = [];

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          for (const relPath of matchedRelativePaths) {
            const fullPath = path.join(workflowsDir, relPath);
            const entry = syncState.workflows[relPath];

            if (!entry) {
              results.push({ file: relPath, status: 'untracked' });
              if (!output.getJsonMode() && !options.summary) {
                output.warn(`\n[UNTRACKED] '${relPath}' is not tracked in sync state. Pull or push first.`);
              }
              continue;
            }

            try {
              const localContent = fs.readFileSync(fullPath, 'utf-8');

              // Fetch remote workflow details (via REST API or MCP fallback)
              const details = await getWorkflowDetails(mcp, instanceUrl, apiKey, entry.id);
              if (!details) {
                results.push({ file: relPath, id: entry.id, status: 'error', error: 'Failed to fetch remote workflow details' });
                continue;
              }

              // Generate remote TypeScript code
              const remoteContent = generateWorkflowCode(details);

              let remoteClean = remoteContent;
              let localClean = localContent;
              if (options.semantic) {
                remoteClean = stripPositions(remoteContent);
                localClean = stripPositions(localContent);
              }

              const origLines = remoteClean.replace(/\r\n/g, '\n').split('\n');
              const modLines = localClean.replace(/\r\n/g, '\n').split('\n');

              const isIdentical = remoteClean.replace(/\r\n/g, '\n') === localClean.replace(/\r\n/g, '\n');

              if (isIdentical) {
                results.push({ file: relPath, id: entry.id, status: 'identical' });
                if (!output.getJsonMode() && !options.summary && matchedRelativePaths.length === 1) {
                  output.log(`Workflow '${relPath}' (ID: ${entry.id}) is identical to remote.`);
                }
              } else {
                results.push({ file: relPath, id: entry.id, status: 'modified' });
                if (!output.getJsonMode() && !options.summary) {
                  output.log(`\n======================================================================`);
                  output.log(`DIFF: ${relPath} (ID: ${entry.id})`);
                  output.log(`======================================================================`);
                  output.log(`--- Remote (${entry.id})`);
                  output.log(`+++ Local (${relPath})`);
                  output.log('@@ -1, +1 @@');
                  printDiff(origLines, modLines);
                }
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              results.push({ file: relPath, id: entry?.id, status: 'error', error: errMsg });
              if (!output.getJsonMode() && !options.summary) {
                output.error(`Error diffing workflow '${relPath}': ${errMsg}`);
              }
            }
          }
        });

        // JSON output
        if (output.getJsonMode()) {
          console.log(JSON.stringify({
            target: targetArg || null,
            totalMatched: results.length,
            modifiedCount: results.filter(r => r.status === 'modified').length,
            identicalCount: results.filter(r => r.status === 'identical').length,
            untrackedCount: results.filter(r => r.status === 'untracked').length,
            errorCount: results.filter(r => r.status === 'error').length,
            workflows: results,
          }, null, 2));
          return;
        }

        // Summary output
        const modified = results.filter(r => r.status === 'modified');
        const identical = results.filter(r => r.status === 'identical');
        const untracked = results.filter(r => r.status === 'untracked');
        const errors = results.filter(r => r.status === 'error');

        if (options.summary || matchedRelativePaths.length > 1) {
          output.log(`\n--- DIFF SUMMARY ---`);
          output.log(`Total checked : ${results.length}`);
          output.log(`Modified      : ${modified.length}`);
          output.log(`Identical     : ${identical.length}`);
          output.log(`Untracked     : ${untracked.length}`);
          if (errors.length > 0) {
            output.warn(`Errors        : ${errors.length}`);
          }
          output.log(`--------------------\n`);
        } else if (results.length === 1 && results[0].status === 'identical') {
          output.log('No differences found.');
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
