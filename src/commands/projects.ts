import { Command } from 'commander';
import { getConnectionInfo } from '../config.js';
import { withMcp } from '../mcp-client.js';
import * as output from '../output.js';

export function projectsCommand(program: Command) {
  program
    .command('projects')
    .description('List all accessible n8n projects with their IDs')
    .option('--query <q>', 'filter projects by name query')
    .option('--type <type>', 'filter by project type (personal or team)')
    .option('--limit <n>', 'limit the number of projects returned', parseInt)
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (options) => {
      try {
        const { mcpCommand, accessToken } = getConnectionInfo(options);

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          const response = await mcp.callToolAndGetJson('search_projects', {
            query: options.query,
            limit: options.limit,
          });

          let projects = Array.isArray(response) ? response : (response.projects || response.data || []);

          if (options.type) {
            projects = projects.filter((p: any) => p.type === options.type);
          }

          if (output.getJsonMode()) {
            console.log(JSON.stringify(projects, null, 2));
            return;
          }

          if (projects.length === 0) {
            output.log('No projects found.');
            return;
          }

          const headers = ['Project ID', 'Project Name', 'Type'];
          const rows = projects.map((p: any) => [p.id, p.name, p.type || 'unknown']);
          
          output.table(headers, rows);
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
