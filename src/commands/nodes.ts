import { Command } from 'commander';
import { getConnectionInfo } from '../config.js';
import { withMcp } from '../mcp-client.js';
import * as output from '../output.js';

export function nodesCommand(program: Command) {
  const nodes = program
    .command('nodes')
    .description('Search nodes, discover parameter types, and get suggestions');

  nodes
    .command('search')
    .description('Search for n8n nodes by service name, trigger type, or utility')
    .argument('<queries...>', 'search queries (e.g., gmail, slack, if, merge)')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (queries, options) => {
      try {
        const { mcpCommand, accessToken } = getConnectionInfo(options);

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          const result = await mcp.callTool('search_nodes', {
            queries,
          });

          const text = result.content?.find((c: any) => c.type === 'text')?.text;
          output.log(text || 'No nodes found matching search queries.');
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  nodes
    .command('types')
    .description('Get TypeScript type definitions for n8n nodes')
    .argument('<nodeIds...>', 'node type IDs (e.g., n8n-nodes-base.gmail, n8n-nodes-base.slack)')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (nodeIds, options) => {
      try {
        const { mcpCommand, accessToken } = getConnectionInfo(options);

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          const result = await mcp.callTool('get_node_types', {
            nodeIds,
          });

          const text = result.content?.find((c: any) => c.type === 'text')?.text;
          output.log(text || 'No types returned.');
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  nodes
    .command('suggest')
    .description('Curate recommended nodes for various categories')
    .argument('<categories...>', 'workflow technique categories (e.g. chatbot, scheduling, triage)')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (categories, options) => {
      try {
        const { mcpCommand, accessToken } = getConnectionInfo(options);

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          const result = await mcp.callTool('get_suggested_nodes', {
            categories,
          });

          const text = result.content?.find((c: any) => c.type === 'text')?.text;
          output.log(text || 'No suggestions returned.');
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
