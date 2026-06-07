import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { getConnectionInfo, resolveAndConvertTarget } from '../config.js';
import { withMcp } from '../mcp-client.js';
import { loadSyncState } from '../sync-state.js';
import * as output from '../output.js';

export function execCommand(program: Command) {
  program
    .command('exec')
    .description('Trigger execution of an n8n workflow')
    .argument('<workflow-id-or-file>', 'workflow ID or local workflow file path')
    .option('--mode <mode>', 'execution mode (production or manual)', 'production')
    .option('--input <json-or-file>', 'workflow input JSON string or file path')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (target, options) => {
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
              output.warn(`Local file '${relativePath}' is not tracked in sync state. Attempting to use path as direct workflow ID.`);
            }
          }
        }

        // Parse inputs if provided
        let inputs: any = undefined;
        if (options.input) {
          try {
            if (fs.existsSync(options.input)) {
              inputs = JSON.parse(fs.readFileSync(options.input, 'utf-8'));
            } else {
              inputs = JSON.parse(options.input);
            }
          } catch (err) {
            throw new Error(`Failed to parse inputs JSON: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        output.log(`Triggering execution of workflow ${workflowId} in ${options.mode} mode...`);

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          const result = await mcp.callTool('execute_workflow', {
            workflowId,
            executionMode: options.mode,
            inputs,
          });

          // Print the output of the execution tool directly
          const text = result.content?.find((c: any) => c.type === 'text')?.text;
          output.log(text || 'Workflow executed successfully.');
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
