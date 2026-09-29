import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { getConnectionInfo } from '../config.js';
import { withMcp } from '../mcp-client.js';
import * as output from '../output.js';

export function debugCommand(program: Command) {
  program
    .command('debug <execution-id>')
    .description('Directly inspect and format error stack trace, node errors, and payload data for an execution ID')
    .option('--json', 'output raw JSON format')
    .option('--db-url <url>', 'override n8n PostgreSQL database connection URL')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (executionId, options) => {
      let pgClient: any = null;
      try {
        const { mcpCommand, accessToken, dbUrl } = getConnectionInfo(options);

        let execution: any = null;

        if (dbUrl) {
          const pgModule = pg as any;
          const ClientClass = pgModule.Client || pgModule.default?.Client || pgModule;
          pgClient = new ClientClass({
            connectionString: dbUrl,
            ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false')) ? false : { rejectUnauthorized: false }
          });
          await pgClient.connect();

          const queryStr = `
            SELECT e.id, e."finished", e."mode", e."status", e."startedAt", e."stoppedAt", e."workflowId",
                   w.name AS workflow_name,
                   d.data AS execution_data
            FROM execution_entity e
            LEFT JOIN execution_data d ON e.id = d."executionId"
            LEFT JOIN workflow_entity w ON e."workflowId" = w.id
            WHERE e.id = $1 OR e.id::text = $1;
          `;

          const res = await pgClient.query(queryStr, [executionId]);
          if (res.rows.length > 0) {
            const row = res.rows[0];
            let dataObj: any = null;
            if (row.execution_data) {
              try {
                dataObj = typeof row.execution_data === 'string' ? JSON.parse(row.execution_data) : row.execution_data;
              } catch (e) {}
            }
            const wfDataObj = dataObj?.workflowData || null;
            execution = {
              id: row.id,
              workflowId: row.workflowId,
              workflowName: row.workflow_name || wfDataObj?.name || 'Unknown Workflow',
              finished: row.finished,
              status: row.status || (row.finished ? 'success' : 'failed'),
              mode: row.mode,
              startedAt: row.startedAt,
              stoppedAt: row.stoppedAt,
              data: dataObj,
              workflowData: wfDataObj,
            };
          }
        }

        if (!execution) {
          // Fallback via MCP
          await withMcp(mcpCommand, accessToken, async (mcp) => {
            const res = await mcp.callToolAndGetJson('get_execution', {
              executionId,
              includeData: true,
            });
            execution = res;
          });
        }

        if (!execution) {
          throw new Error(`Execution ID '${executionId}' not found in database or API.`);
        }

        if (output.getJsonMode()) {
          console.log(JSON.stringify(execution, null, 2));
          return;
        }

        output.log(`\n====================================================`);
        output.log(`DEBUG REPORT FOR EXECUTION ID: ${execution.id}`);
        output.log(`====================================================`);
        output.log(`Workflow Name: ${execution.workflowName || execution.workflowData?.name || 'N/A'}`);
        output.log(`Workflow ID:   ${execution.workflowId || 'N/A'}`);
        output.log(`Status:        ${execution.status ? execution.status.toUpperCase() : 'N/A'}`);
        output.log(`Mode:          ${execution.mode || 'N/A'}`);
        if (execution.startedAt) output.log(`Started At:    ${new Date(execution.startedAt).toLocaleString()}`);
        if (execution.stoppedAt) output.log(`Stopped At:    ${new Date(execution.stoppedAt).toLocaleString()}`);

        const runData = execution.data?.resultData?.runData || execution.resultData?.runData;
        const globalError = execution.data?.resultData?.error || execution.resultData?.error;

        if (globalError) {
          output.error(`\n🚨 GLOBAL ERROR:`);
          output.error(`   Message: ${globalError.message || JSON.stringify(globalError)}`);
          if (globalError.description) output.error(`   Description: ${globalError.description}`);
          if (globalError.lineNumber) output.error(`   Line Number: ${globalError.lineNumber}`);
          if (globalError.stack) {
            output.error(`   Stack Trace:\n${globalError.stack}`);
          }
        }

        let failedNodeFound = false;
        if (runData && typeof runData === 'object') {
          output.log(`\nNode Breakdown:`);
          output.log(`----------------------------------------------------`);
          for (const [nodeName, runs] of Object.entries(runData)) {
            if (Array.isArray(runs)) {
              for (let i = 0; i < runs.length; i++) {
                const run: any = runs[i];
                const suffix = runs.length > 1 ? ` (Run ${i + 1})` : '';
                if (run.error) {
                  failedNodeFound = true;
                  output.error(`❌ FAILED NODE: "${nodeName}"${suffix}`);
                  output.error(`   Execution Time: ${run.executionTime !== undefined ? run.executionTime + ' ms' : 'N/A'}`);
                  output.error(`   Error Message:  ${run.error.message || JSON.stringify(run.error)}`);
                  if (run.error.description) output.error(`   Description:    ${run.error.description}`);
                  if (run.error.lineNumber) output.error(`   Line Number:    ${run.error.lineNumber}`);
                  if (run.error.stack) {
                    output.error(`   Stack Trace:\n${run.error.stack}`);
                  }
                  if (run.data) {
                    output.error(`   Input/Output Payload at Error:`);
                    output.error(JSON.stringify(run.data, null, 2));
                  }
                } else {
                  output.log(`✅ SUCCESS NODE: "${nodeName}"${suffix} (${run.executionTime !== undefined ? run.executionTime + ' ms' : ''})`);
                }
              }
            }
          }
        }

        if (!failedNodeFound && !globalError) {
          output.log(`\nNo node errors were found in this execution.`);
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
