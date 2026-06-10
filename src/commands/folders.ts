import { Command } from 'commander';
import pg from 'pg';
import { getConnectionInfo } from '../config.js';
import { withMcp } from '../mcp-client.js';
import * as output from '../output.js';

function generateFolderId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function foldersCommand(program: Command) {
  const folders = program
    .command('folders')
    .description('List and manage folders in an n8n project');

  folders
    .command('list', { isDefault: true })
    .description('List folders in an n8n project')
    .option('--project-id <id>', 'n8n project ID (defaults to config file projectId)')
    .option('--query <q>', 'filter folders by name query')
    .option('--limit <n>', 'limit the number of folders returned', parseInt)
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (options) => {
      try {
        const { mcpCommand, accessToken, config, instanceUrl } = getConnectionInfo(options);
        
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

          const foldersList = Array.isArray(response) ? response : (response.folders || []);

          if (output.getJsonMode()) {
            console.log(JSON.stringify(foldersList, null, 2));
            return;
          }

          if (foldersList.length === 0) {
            output.log('No folders found.');
            return;
          }

          const headers = ['Folder ID', 'Folder Name', 'Project ID'];
          const rows = foldersList.map((f: any) => [f.id, f.name, f.projectId || projectId]);
          
          output.table(headers, rows);
        }, instanceUrl);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  folders
    .command('create <name>')
    .description('Create a new folder directly in n8n database')
    .option('--project-id <id>', 'n8n project ID (defaults to config file projectId)')
    .option('--parent-folder-id <id>', 'optional parent folder ID')
    .option('--db-url <url>', 'n8n PostgreSQL database connection URL')
    .action(async (name, options) => {
      try {
        const { dbUrl, config } = getConnectionInfo(options);
        
        const projectId = options.projectId || (config && config.projectId);
        if (!projectId) {
          throw new Error('Project ID is required. Pass --project-id or initialize configuration with a project first.');
        }

        if (!dbUrl) {
          throw new Error('Database URL (dbUrl) is required to create folders. Configure it globally or pass via --db-url.');
        }

        const folderId = generateFolderId();
        const parentFolderId = options.parentFolderId || null;

        const pgModule = pg as any;
        const ClientClass = pgModule.Client || pgModule.default?.Client || pgModule;
        const pgClient = new ClientClass({
          connectionString: dbUrl,
          ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false')) ? false : { rejectUnauthorized: false }
        });

        output.log(`Connecting to database to create folder '${name}'...`);
        await pgClient.connect();
        try {
          await pgClient.query(
            'INSERT INTO folder (id, name, "parentFolderId", "projectId", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, NOW(), NOW());',
            [folderId, name, parentFolderId, projectId]
          );
          output.log(`Successfully created folder '${name}' (ID: ${folderId}, parent: ${parentFolderId || 'root'})`);
        } finally {
          await pgClient.end();
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
