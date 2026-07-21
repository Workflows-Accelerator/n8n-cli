import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { parseWorkflowCodeToBuilder } from '@n8n/workflow-sdk';
import { getConnectionInfo, resolveAndConvertTarget } from '../config.js';
import { withMcp } from '../mcp-client.js';
import { loadSyncState, syncWorkflowVersionAndHistory, isTargetScoped } from '../sync-state.js';
import * as output from '../output.js';

export function publishCommand(program: Command) {
  program
    .command('publish')
    .description('Publish (activate) a workflow on the n8n instance and sync version snapshots')
    .argument('<workflow-id-or-file>', 'workflow ID or local workflow file path')
    .option('--version-id <id>', 'optional version ID to publish (defaults to current draft)')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .option('--db-url <url>', 'override n8n PostgreSQL database connection URL')
    .action(async (target, options) => {
      let pgClient: any = null;
      try {
        const { mcpCommand, accessToken, repoRoot, localDir, dbUrl } = getConnectionInfo(options);

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

        output.log(`Publishing workflow ${workflowId}...`);

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          const result = await mcp.callTool('publish_workflow', {
            workflowId,
            versionId: options.versionId,
          });

          const text = result.content?.find((c: any) => c.type === 'text')?.text;
          output.log(text || 'Workflow published successfully.');

          // If dbUrl is provided, invalidate/sync runtime version in workflow_history / workflow_entity
          if (dbUrl) {
            try {
              let workflowJson: any = null;
              if (localFilePath && fs.existsSync(localFilePath)) {
                const code = fs.readFileSync(localFilePath, 'utf-8');
                const builder = parseWorkflowCodeToBuilder(code);
                workflowJson = builder.toJSON();
              } else {
                const detailsRes = await mcp.callToolAndGetJson('get_workflow_details', {
                  workflowId,
                  id: workflowId,
                });
                workflowJson = detailsRes.workflow || detailsRes;
              }

              if (workflowJson) {
                const pgModule = pg as any;
                const ClientClass = pgModule.Client || pgModule.default?.Client || pgModule;
                pgClient = new ClientClass({
                  connectionString: dbUrl,
                  ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false')) ? false : { rejectUnauthorized: false }
                });
                await pgClient.connect();
                await syncWorkflowVersionAndHistory(pgClient, workflowId, workflowJson);
                output.log(`  [VERSION SYNC] Invalidated active version snapshot in PostgreSQL database for workflow ${workflowId}.`);
              }
            } catch (dbErr) {
              output.warn(`Failed to sync version history in database: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
            }
          }
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        if (pgClient) {
          try {
            await pgClient.end();
          } catch (e) {}
        }
      }
    });
}

