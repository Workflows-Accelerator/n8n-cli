import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { getConnectionInfo, resolveAndConvertTarget } from '../config.js';
import { withMcp } from '../mcp-client.js';
import { loadSyncState } from '../sync-state.js';
import * as output from '../output.js';

export function logsCommand(program: Command) {
  program
    .command('logs [workflow-id-or-file]')
    .description('Fetch and format recent execution logs and failure stack traces for a workflow')
    .option('--limit <n>', 'limit the number of executions returned', (val) => parseInt(val, 10), 10)
    .option('--failed-only', 'filter output to display only failed workflow executions', false)
    .option('--last-failed', 'fetch and display the most recent failed execution with full stack trace and error payload', false)
    .option('--json', 'output raw JSON format')
    .option('--db-url <url>', 'override n8n PostgreSQL database connection URL')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (target, options) => {
      let pgClient: any = null;
      try {
        const { mcpCommand, accessToken, repoRoot, localDir, dbUrl } = getConnectionInfo(options);

        let workflowId: string | null = null;
        if (target) {
          workflowId = target;
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
              }
            }
          }
        }

        const failedOnly = options.failedOnly || options.lastFailed;
        const limit = options.lastFailed ? 1 : (options.limit || 10);
        let executions: any[] = [];

        if (dbUrl) {
          const pgModule = pg as any;
          const ClientClass = pgModule.Client || pgModule.default?.Client || pgModule;
          pgClient = new ClientClass({
            connectionString: dbUrl,
            ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false')) ? false : { rejectUnauthorized: false }
          });
          await pgClient.connect();

          let queryStr = `
            SELECT e.id, e."finished", e."mode", e."status", e."startedAt", e."stoppedAt", e."workflowId",
                   d.data AS execution_data
            FROM execution_entity e
            LEFT JOIN execution_data d ON e.id = d."executionId"
          `;
          const params: any[] = [];
          const whereClauses: string[] = [];

          if (workflowId) {
            params.push(workflowId);
            whereClauses.push(`e."workflowId" = $${params.length}`);
          }
          if (failedOnly) {
            whereClauses.push(`(e.finished = false OR e.status = 'failed' OR e.status = 'crashed' OR e.status = 'error')`);
          }

          if (whereClauses.length > 0) {
            queryStr += ` WHERE ${whereClauses.join(' AND ')}`;
          }
          params.push(limit);
          queryStr += ` ORDER BY e."startedAt" DESC LIMIT $${params.length};`;

          const res = await pgClient.query(queryStr, params);
          executions = res.rows.map((row: any) => {
            let dataObj: any = null;
            if (row.execution_data) {
              try {
                dataObj = typeof row.execution_data === 'string' ? JSON.parse(row.execution_data) : row.execution_data;
              } catch (e) {}
            }
            return {
              id: row.id,
              workflowId: row.workflowId,
              finished: row.finished,
              status: row.status || (row.finished ? 'success' : 'failed'),
              mode: row.mode,
              startedAt: row.startedAt,
              stoppedAt: row.stoppedAt,
              data: dataObj,
            };
          });
        } else {
          // Fallback via MCP
          await withMcp(mcpCommand, accessToken, async (mcp) => {
            if (!workflowId) {
              throw new Error('Workflow ID or file is required when database URL is not configured.');
            }
            const res = await mcp.callToolAndGetJson('get_execution', {
              workflowId,
              limit,
              includeData: true,
            });
            const list = Array.isArray(res) ? res : [res];
            executions = list;
          });
        }

        if (output.getJsonMode()) {
          console.log(JSON.stringify(executions, null, 2));
          return;
        }

        if (executions.length === 0) {
          output.log('No workflow executions found.');
          return;
        }

        output.log(`Showing ${executions.length} recent execution log(s):`);
        output.log('====================================================');

        for (const exec of executions) {
          const isSuccess = exec.finished && exec.status !== 'failed' && exec.status !== 'crashed' && exec.status !== 'error';
          const icon = isSuccess ? '✅' : '❌';
          output.log(`\n[${icon} ${exec.status.toUpperCase()}] Execution ID: ${exec.id}`);
          output.log(`  Workflow ID: ${exec.workflowId || 'N/A'}`);
          output.log(`  Mode:        ${exec.mode || 'N/A'}`);
          output.log(`  Started:     ${exec.startedAt ? new Date(exec.startedAt).toLocaleString() : 'N/A'}`);
          if (exec.stoppedAt) output.log(`  Stopped:     ${new Date(exec.stoppedAt).toLocaleString()}`);

          // Extract stack traces and node failures
          const runData = exec.data?.resultData?.runData || exec.resultData?.runData;
          const globalError = exec.data?.resultData?.error || exec.resultData?.error;

          if (globalError) {
            output.error(`  Global Error: ${globalError.message || JSON.stringify(globalError)}`);
            if (globalError.stack) {
              output.error(`  Stack Trace:\n${globalError.stack}`);
            }
          }

          if (runData && typeof runData === 'object') {
            for (const [nodeName, runs] of Object.entries(runData)) {
              if (Array.isArray(runs)) {
                for (let i = 0; i < runs.length; i++) {
                  const run: any = runs[i];
                  if (run && run.error) {
                    output.error(`  ❌ Failed Node: "${nodeName}" (Run ${i + 1})`);
                    output.error(`     Message:     ${run.error.message || JSON.stringify(run.error)}`);
                    if (run.error.stack) {
                      output.error(`     Stack Trace:\n${run.error.stack}`);
                    }
                  }
                }
              }
            }
          }
        }
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
