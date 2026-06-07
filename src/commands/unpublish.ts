import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { getConnectionInfo, resolveAndConvertTarget } from '../config.js';
import { withMcp } from '../mcp-client.js';
import { loadSyncState } from '../sync-state.js';
import * as output from '../output.js';

export function unpublishCommand(program: Command) {
  program
    .command('unpublish')
    .description('Unpublish (deactivate) a workflow on the n8n instance')
    .argument('<workflow-id-or-file>', 'workflow ID or local workflow file path')
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
              output.warn(`Local file '${relativePath}' is not tracked. Attempting to use path as direct workflow ID.`);
            }
          }
        }

        output.log(`Deactivating workflow ${workflowId}...`);

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          const result = await mcp.callTool('unpublish_workflow', {
            workflowId,
          });

          const text = result.content?.find((c: any) => c.type === 'text')?.text;
          output.log(text || 'Workflow unpublished successfully.');
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
