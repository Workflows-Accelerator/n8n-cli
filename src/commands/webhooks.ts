import { Command } from 'commander';
import pg from 'pg';
import { getConnectionInfo } from '../config.js';
import { withMcp } from '../mcp-client.js';
import * as output from '../output.js';

export function webhooksCommand(program: Command) {
  const webhooksCmd = program
    .command('webhooks')
    .description('Manage and verify webhook health across n8n workflows');

  webhooksCmd
    .command('verify')
    .description('Validate that all active webhook routes in webhook_entity match active workflow trigger definitions')
    .option('--db-url <url>', 'override n8n PostgreSQL database connection URL')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .option('--json', 'output raw JSON format')
    .action(async (options) => {
      let pgClient: any = null;
      try {
        const { mcpCommand, accessToken, dbUrl } = getConnectionInfo(options);

        let webhooks: any[] = [];
        let workflows: any[] = [];

        if (dbUrl) {
          const pgModule = pg as any;
          const ClientClass = pgModule.Client || pgModule.default?.Client || pgModule;
          pgClient = new ClientClass({
            connectionString: dbUrl,
            ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false')) ? false : { rejectUnauthorized: false }
          });
          await pgClient.connect();

          let schema = 'public';
          try {
            const colsRes = await pgClient.query(`
              SELECT table_schema FROM information_schema.columns WHERE table_name = 'workflow_entity' LIMIT 1;
            `);
            if (colsRes.rows.length > 0) schema = colsRes.rows[0].table_schema;
          } catch (e) {}

          const whRes = await pgClient.query(`
            SELECT "webhookPath", "method", "node", "workflowId" FROM "${schema}"."webhook_entity";
          `);
          webhooks = whRes.rows;

          const wfRes = await pgClient.query(`
            SELECT "id", "name", "nodes", "active", "isArchived" FROM "${schema}"."workflow_entity";
          `);
          workflows = wfRes.rows.map((row: any) => ({
            id: row.id,
            name: row.name,
            active: row.active ?? true,
            isArchived: row.isArchived ?? false,
            nodes: typeof row.nodes === 'string' ? JSON.parse(row.nodes) : (row.nodes || [])
          }));
        } else {
          // Fallback via MCP
          await withMcp(mcpCommand, accessToken, async (mcp) => {
            const searchResult = await mcp.callToolAndGetJson('search_workflows', { limit: 200 });
            workflows = Array.isArray(searchResult) ? searchResult : (searchResult.data || searchResult.workflows || []);
          });
        }

        const activeWorkflowsMap = new Map<string, any>();
        for (const wf of workflows) {
          if (!wf.isArchived) {
            activeWorkflowsMap.set(String(wf.id), wf);
          }
        }

        const validWebhooks: any[] = [];
        const orphanedWebhooks: any[] = [];
        const missingWebhooks: any[] = [];

        // Verify webhooks registered in database
        for (const hook of webhooks) {
          const parentWf = activeWorkflowsMap.get(String(hook.workflowId));
          if (!parentWf) {
            orphanedWebhooks.push(hook);
          } else {
            // Check if trigger node exists in workflow
            const triggerNode = (parentWf.nodes || []).find((n: any) => n.name === hook.node);
            if (triggerNode) {
              validWebhooks.push({ ...hook, workflowName: parentWf.name });
            } else {
              orphanedWebhooks.push({ ...hook, workflowName: parentWf.name, reason: 'Trigger node removed from workflow' });
            }
          }
        }

        // Verify trigger nodes in active workflows that should have registered webhooks
        for (const [wfId, wf] of activeWorkflowsMap.entries()) {
          if (!wf.active) continue; // Inactive workflows don't register webhooks
          for (const node of wf.nodes || []) {
            const typeLower = (node.type || '').toLowerCase();
            if (typeLower.includes('webhook') || typeLower.includes('form') || typeLower.includes('trigger')) {
              const registered = webhooks.some(h => String(h.workflowId) === wfId && h.node === node.name);
              if (!registered) {
                missingWebhooks.push({
                  workflowId: wfId,
                  workflowName: wf.name,
                  nodeName: node.name,
                  nodeType: node.type,
                });
              }
            }
          }
        }

        if (output.getJsonMode() || options.json) {
          output.log(JSON.stringify({
            totalRegisteredWebhooks: webhooks.length,
            validWebhooks,
            orphanedWebhooks,
            missingWebhooks,
          }, null, 2));
          return;
        }

        output.log(`\n====================================================`);
        output.log(`WEBHOOK HEALTH DIAGNOSTIC REPORT`);
        output.log(`====================================================`);
        output.log(`Total Registered Webhook Routes: ${webhooks.length}`);
        output.log(`Valid Active Routes:             ${validWebhooks.length} ✅`);
        output.log(`Orphaned Webhook Routes:          ${orphanedWebhooks.length} ${orphanedWebhooks.length > 0 ? '❌' : '✅'}`);
        output.log(`Missing Webhook Registrations:    ${missingWebhooks.length} ${missingWebhooks.length > 0 ? '⚠️' : '✅'}`);

        if (orphanedWebhooks.length > 0) {
          output.error(`\nORPHANED WEBHOOK ROUTES (in webhook_entity but target workflow/node missing):`);
          output.error(`----------------------------------------------------`);
          for (const orphan of orphanedWebhooks) {
            output.error(`  - Path: "${orphan.webhookPath}" [${orphan.method || 'GET'}]`);
            output.error(`    Workflow ID: ${orphan.workflowId} (${orphan.workflowName || 'Deleted Workflow'})`);
            output.error(`    Node Name:   ${orphan.node}`);
          }
        }

        if (missingWebhooks.length > 0) {
          output.warn(`\nMISSING WEBHOOK REGISTRATIONS (Active workflow triggers without webhook_entity entry):`);
          output.warn(`----------------------------------------------------`);
          for (const missing of missingWebhooks) {
            output.warn(`  - Workflow: "${missing.workflowName}" (${missing.workflowId})`);
            output.warn(`    Node:     "${missing.nodeName}" [${missing.nodeType}]`);
          }
        }

        if (orphanedWebhooks.length === 0 && missingWebhooks.length === 0) {
          output.log(`\n🎉 All webhook routes and active triggers are 100% healthy and in sync!`);
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
