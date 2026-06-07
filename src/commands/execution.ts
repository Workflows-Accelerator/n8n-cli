import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { getConnectionInfo } from '../config.js';
import { withMcp } from '../mcp-client.js';
import { loadSyncState } from '../sync-state.js';
import * as output from '../output.js';

export function executionCommand(program: Command) {
  program
    .command('execution')
    .description('Retrieve the execution details for a workflow run')
    .argument('<workflow-id-or-file>', 'workflow ID or local workflow file path')
    .argument('<execution-id>', 'execution ID')
    .option('--include-data', 'include node execution input/output data', false)
    .option('--nodes <names...>', 'filter execution data by specific node names')
    .option('--truncate <n>', 'limit the number of data items returned per node output', parseInt)
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (target, executionId, options) => {
      try {
        const { mcpCommand, accessToken, repoRoot, localDir } = getConnectionInfo(options);

        let workflowId = target;

        // Try to resolve from sync state if a file path is provided
        if (repoRoot) {
          const fullPath = path.resolve(target);
          const workflowsDir = path.join(repoRoot, localDir, 'workflows');
          if (fs.existsSync(fullPath)) {
            const relativePath = path.relative(workflowsDir, fullPath).replace(/\\/g, '/');
            const syncState = loadSyncState(repoRoot, localDir);
            const entry = syncState.workflows[relativePath];
            if (entry) {
              workflowId = entry.id;
              output.log(`Resolved local file '${relativePath}' to workflow ID: ${workflowId}`);
            } else {
              output.warn(`Local file '${relativePath}' is not tracked. Attempting to use path as direct workflow ID.`);
            }
          }
        }

        output.log(`Retrieving execution details for ID ${executionId}...`);

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          const result = await mcp.callTool('get_execution', {
            workflowId,
            executionId,
            includeData: options.includeData,
            nodeNames: options.nodes,
            truncateData: options.truncate,
          });

          // Print results
          const text = result.content?.find((c: any) => c.type === 'text')?.text;
          output.log(text || 'No execution details returned.');
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
