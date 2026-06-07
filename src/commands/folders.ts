import { Command } from 'commander';
import { getConnectionInfo } from '../config.js';
import { withMcp } from '../mcp-client.js';
import * as output from '../output.js';

export function foldersCommand(program: Command) {
  program
    .command('folders')
    .description('List folders in an n8n project')
    .option('--project-id <id>', 'n8n project ID (defaults to config file projectId)')
    .option('--query <q>', 'filter folders by name query')
    .option('--limit <n>', 'limit the number of folders returned', parseInt)
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (options) => {
      try {
        const { mcpCommand, accessToken, config } = getConnectionInfo(options);
        
        const projectId = options.projectId || (config && config.projectId);
        if (!projectId) {
          throw new Error('Project ID is required. Pass --project-id or initialize configuration with a project first.');
        }

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          const response = await mcp.callToolAndGetJson('search_folders', {
            projectId,
            query: options.query,
            limit: options.limit,
          });

          const folders = Array.isArray(response) ? response : (response.folders || []);

          if (folders.length === 0) {
            output.log('No folders found.');
            return;
          }

          const headers = ['Folder ID', 'Folder Name', 'Project ID'];
          const rows = folders.map((f: any) => [f.id, f.name, f.projectId || projectId]);
          
          output.table(headers, rows);
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
