import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { getConnectionInfo, resolveAndConvertTarget } from '../config.js';
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
    .option('--node <names...>', 'filter execution data by specific node names (alias for --nodes)')
    .option('--truncate <n>', 'limit the number of data items returned per node output', parseInt)
    .option('--json', 'output raw JSON format')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (target, executionId, options) => {
      try {
        const { mcpCommand, accessToken, repoRoot, localDir } = getConnectionInfo(options);

        let workflowId = target;

        // Try to resolve from sync state if a file path is provided
        if (repoRoot) {
          const workflowsDir = path.join(repoRoot, localDir, 'workflows');
          const resolvedTarget = resolveAndConvertTarget(target, workflowsDir);
          const fullPath = path.resolve(resolvedTarget);
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
          const nodeFilters = options.node || options.nodes;

          let execution: any = null;
          try {
            execution = await mcp.callToolAndGetJson('get_execution', {
              workflowId,
              executionId,
              includeData: options.includeData,
              nodeNames: nodeFilters,
              truncateData: options.truncate,
            });
          } catch (err) {
            // Fallback to text if JSON parsing fails
          }

          if (execution && typeof execution === 'object') {
            if (output.getJsonMode()) {
              output.log(JSON.stringify(execution, null, 2));
              return;
            }

            // Print beautiful summary
            output.log(`Execution ID: ${execution.id || executionId}`);
            output.log(`Status:       ${execution.status || (execution.finished ? 'success' : 'failed')}`);
            output.log(`Mode:         ${execution.mode || 'N/A'}`);
            if (execution.startedAt) output.log(`Started At:   ${execution.startedAt}`);
            if (execution.stoppedAt) output.log(`Stopped At:   ${execution.stoppedAt}`);

            const runData = execution.data?.resultData?.runData;
            if (runData && Object.keys(runData).length > 0) {
              output.log(`\nNode Execution Details:`);
              output.log(`========================================`);
              for (const [nodeName, runs] of Object.entries(runData)) {
                if (Array.isArray(runs)) {
                  for (let idx = 0; idx < runs.length; idx++) {
                    const run = runs[idx];
                    const suffix = runs.length > 1 ? ` (Run ${idx + 1})` : '';
                    const statusStr = run.error ? '❌ FAILED' : '✅ SUCCESS';
                    output.log(`\nNode: ${nodeName}${suffix} [${statusStr}]`);
                    if (run.executionTime !== undefined) {
                      output.log(`  Duration: ${run.executionTime} ms`);
                    }
                    if (run.error) {
                      output.error(`  Error:    ${run.error.message || JSON.stringify(run.error)}`);
                      if (run.error.stack) {
                        output.error(`  Stack:\n${run.error.stack}`);
                      }
                    }
                    if (options.includeData && run.data) {
                      output.log(`  Data:`);
                      output.log(JSON.stringify(run.data, null, 2));
                    }
                  }
                }
              }
            }
          } else {
            const result = await mcp.callTool('get_execution', {
              workflowId,
              executionId,
              includeData: options.includeData,
              nodeNames: nodeFilters,
              truncateData: options.truncate,
            });

            // Print results
            const text = result.content?.find((c: any) => c.type === 'text')?.text;
            output.log(text || 'No execution details returned.');
          }
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
