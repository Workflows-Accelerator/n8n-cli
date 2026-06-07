import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { getConnectionInfo, resolveAndConvertTarget } from '../config.js';
import { withMcp } from '../mcp-client.js';
import { loadSyncState } from '../sync-state.js';
import { generateWorkflowCode } from '@n8n/workflow-sdk';
import * as output from '../output.js';

function computeLcs(orig: string[], mod: string[]): Int32Array {
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

function printDiff(orig: string[], mod: string[]) {
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

export function diffCommand(program: Command) {
  program
    .command('diff')
    .description('Show differences between local workflow file and its remote version')
    .argument('<file>', 'path to the local workflow file')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (file, options) => {
      try {
        const { mcpCommand, accessToken, repoRoot, localDir } = getConnectionInfo(options);
        if (!repoRoot) {
          throw new Error('Project must be initialized. Run `n8ncli init` first.');
        }

        const workflowsDir = path.join(repoRoot, localDir, 'workflows');
        const resolvedFile = resolveAndConvertTarget(file, workflowsDir);
        const fullPath = path.resolve(resolvedFile);
        if (!fs.existsSync(fullPath)) {
          throw new Error(`Local file not found at ${fullPath}`);
        }

        const relativePath = path.relative(workflowsDir, fullPath).replace(/\\/g, '/');

        const syncState = loadSyncState(repoRoot, localDir);
        const entry = syncState.workflows[relativePath];

        if (!entry) {
          throw new Error(`File '${relativePath}' is not tracked in sync state. Pull or push first.`);
        }

        output.log(`Diffing local file '${relativePath}' against remote version (ID: ${entry.id})...`);

        const localContent = fs.readFileSync(fullPath, 'utf-8');

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          // Fetch remote workflow JSON
          const detailsRes = await mcp.callToolAndGetJson('get_workflow_details', {
            workflowId: entry.id,
            id: entry.id,
          });
          const details = detailsRes.workflow || detailsRes;

          // Generate remote TS code
          const remoteContent = generateWorkflowCode(details);

          const origLines = remoteContent.replace(/\r\n/g, '\n').split('\n');
          const modLines = localContent.replace(/\r\n/g, '\n').split('\n');

          output.log(`--- Remote (${entry.id})`);
          output.log(`+++ Local (${relativePath})`);
          output.log('@@ -1, +1 @@');
          printDiff(origLines, modLines);
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
