import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { parseWorkflowCodeToBuilder } from '@n8n/workflow-sdk';
import { getConnectionInfo, resolveAndConvertTarget } from '../config.js';
import { withMcp } from '../mcp-client.js';
import { loadSyncState, isTargetScoped } from '../sync-state.js';
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
        let localFilePath: string | null = null;

        // Try to resolve target from file path, workflow JSON code, or sync state
        if (repoRoot) {
          const workflowsDir = path.join(repoRoot, localDir, 'workflows');
          const syncState = loadSyncState(repoRoot, localDir);
          const resolvedTarget = resolveAndConvertTarget(target, workflowsDir);
          const fullPath = path.resolve(resolvedTarget);

          if (fs.existsSync(fullPath)) {
            localFilePath = fullPath;
            try {
              const code = fs.readFileSync(fullPath, 'utf-8');
              const builder = parseWorkflowCodeToBuilder(code);
              const wfJson = builder.toJSON();
              if (wfJson && wfJson.id) {
                workflowId = wfJson.id;
              }
            } catch (e) {}

            if (!workflowId || workflowId === target) {
              const relativePath = path.relative(workflowsDir, fullPath).replace(/\\/g, '/');
              const entry = syncState.workflows[relativePath];
              if (entry) {
                workflowId = entry.id;
              }
            }
          }

          // If not resolved by direct path, match against syncState using isTargetScoped
          if (workflowId === target) {
            const matchedEntry = Object.entries(syncState.workflows).find(([relPath, entry]) =>
              isTargetScoped(relPath, entry.id, entry.name, target)
            );
            if (matchedEntry) {
              workflowId = matchedEntry[1].id;
              localFilePath = path.join(workflowsDir, matchedEntry[0]);
            }
          }

          if (localFilePath && fs.existsSync(localFilePath)) {
            const relPath = path.relative(workflowsDir, localFilePath).replace(/\\/g, '/');
            output.log(`Resolved target '${target}' to workflow ID: ${workflowId} (${relPath})`);
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
