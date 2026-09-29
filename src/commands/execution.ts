import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { getConnectionInfo, resolveAndConvertTarget } from '../config.js';
import { withMcp } from '../mcp-client.js';
import { loadSyncState } from '../sync-state.js';
import * as output from '../output.js';

async function fetchDbExecution(dbUrl: string, targetId: string, executionId?: string): Promise<any | null> {
  const pgModule = pg as any;
  const ClientClass = pgModule.Client || pgModule.default?.Client || pgModule;
  const client = new ClientClass({
    connectionString: dbUrl,
    ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false')) ? false : { rejectUnauthorized: false }
  });
  await client.connect();
  try {
    let queryStr = `
      SELECT e.id, e."finished", e."mode", e."status", e."startedAt", e."stoppedAt", e."workflowId",
             d.data AS execution_data
      FROM execution_entity e
      LEFT JOIN execution_data d ON e.id = d."executionId"
    `;
    const params: any[] = [];
    if (executionId) {
      params.push(executionId);
      queryStr += ` WHERE e.id = $1 LIMIT 1;`;
    } else {
      params.push(targetId);
      queryStr += ` WHERE (e.id = $1 OR e."workflowId" = $1) ORDER BY e."startedAt" DESC LIMIT 1;`;
    }

    const res = await client.query(queryStr, params);
    if (res.rows.length === 0) return null;

    const row = res.rows[0];
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
  } finally {
    await client.end();
  }
}

export function executionCommand(program: Command) {
  const execCmd = program
    .command('execution [workflow-id-or-file] [execution-id]')
    .description('Retrieve execution details or inspect failed stack traces for a workflow run')
    .option('--include-data', 'include node execution input/output data', false)
    .option('--nodes <names...>', 'filter execution data by specific node names')
    .option('--node <names...>', 'filter execution data by specific node names (alias for --nodes)')
    .option('--truncate <n>', 'limit the number of data items returned per node output', parseInt)
    .option('--json', 'output raw JSON format')
    .option('--db-url <url>', 'override n8n PostgreSQL database connection URL')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (target, execIdArg, options) => {
      if (!target) {
        execCmd.help();
        return;
      }
      await runExecutionInspection(target, execIdArg, options);
    });

  execCmd
    .command('inspect <workflow-id-or-file-or-execution-id> [execution-id]')
    .description('Inspect detailed stack traces, failed node inputs/outputs, and error payloads for an execution')
    .option('--include-data', 'include full node execution input/output data payload', true)
    .option('--json', 'output raw JSON format')
    .option('--db-url <url>', 'override n8n PostgreSQL database connection URL')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (target, execIdArg, options) => {
      await runExecutionInspection(target, execIdArg, { ...options, includeData: true });
    });
}

async function runExecutionInspection(target: string, execIdArg: string | undefined, options: any) {
  try {
    const { mcpCommand, accessToken, repoRoot, localDir, dbUrl } = getConnectionInfo(options);

    let workflowId = target;
    let executionId = execIdArg;

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

    let execution: any = null;

    if (dbUrl) {
      try {
        execution = await fetchDbExecution(dbUrl, workflowId, executionId);
      } catch (e) {}
    }

    if (!execution) {
      await withMcp(mcpCommand, accessToken, async (mcp) => {
        const nodeFilters = options.node || options.nodes;
        try {
          execution = await mcp.callToolAndGetJson('get_execution', {
            workflowId,
            executionId: executionId || workflowId,
            includeData: options.includeData,
            nodeNames: nodeFilters,
            truncateData: options.truncate,
          });
        } catch (err) {}
      });
    }

    if (execution && typeof execution === 'object') {
      if (output.getJsonMode() || options.json) {
        output.log(JSON.stringify(execution, null, 2));
        return;
      }

      output.log(`\n====================================================`);
      output.log(`EXECUTION DIAGNOSTIC SUMMARY`);
      output.log(`====================================================`);
      output.log(`Execution ID: ${execution.id || executionId || 'N/A'}`);
      output.log(`Workflow ID:  ${execution.workflowId || workflowId || 'N/A'}`);
      output.log(`Status:       ${execution.status || (execution.finished ? 'success' : 'failed')}`);
      output.log(`Mode:         ${execution.mode || 'N/A'}`);
      if (execution.startedAt) output.log(`Started At:   ${execution.startedAt}`);
      if (execution.stoppedAt) output.log(`Stopped At:   ${execution.stoppedAt}`);

      const runData = execution.data?.resultData?.runData || execution.resultData?.runData;
      const lastNodeExecuted = execution.data?.resultData?.lastNodeExecuted;
      const globalError = execution.data?.resultData?.error || execution.resultData?.error;

      if (lastNodeExecuted) {
        output.log(`Last Node Executed: "${lastNodeExecuted}"`);
      }

      if (globalError) {
        output.error(`\n❌ GLOBAL ERROR: ${globalError.message || JSON.stringify(globalError)}`);
        if (globalError.stack) {
          output.error(`\nSTACK TRACE:\n${globalError.stack}`);
        }
      }

      if (runData && Object.keys(runData).length > 0) {
        output.log(`\nNODE EXECUTION TRAIL:`);
        output.log(`----------------------------------------------------`);
        for (const [nodeName, runs] of Object.entries(runData)) {
          if (Array.isArray(runs)) {
            for (let idx = 0; idx < runs.length; idx++) {
              const run = runs[idx];
              const statusStr = run.error ? '❌ FAILED' : '✅ SUCCESS';
              output.log(`Node: "${nodeName}" (Run ${idx + 1}) [${statusStr}]`);
              if (run.executionTime !== undefined) output.log(`  Duration: ${run.executionTime} ms`);
              if (run.error) {
                output.error(`  Error Message: ${run.error.message || JSON.stringify(run.error)}`);
                if (run.error.stack) {
                  output.error(`  Stack Trace:\n${run.error.stack}`);
                }
              }
              if (options.includeData && run.data) {
                output.log(`  Node Payload Data:`);
                output.log(JSON.stringify(run.data, null, 2));
              }
            }
          }
        }
      }
    } else {
      output.warn(`Could not retrieve execution details for ID '${executionId || workflowId}'.`);
    }
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
