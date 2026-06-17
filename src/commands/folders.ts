import { Command } from 'commander';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { getConnectionInfo, resolveAndConvertTarget } from '../config.js';
import { loadSyncState } from '../sync-state.js';
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

async function getWorkflowFolderColumn(client: any): Promise<string> {
  const colsRes = await client.query(`
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_name = 'workflow_entity';
  `);
  const cols = colsRes.rows.map((r: any) => r.column_name);
  if (cols.includes('parentFolderId')) return 'parentFolderId';
  if (cols.includes('folderId')) return 'folderId';
  const found = cols.find((c: string) => c.toLowerCase().includes('folder'));
  return found || 'parentFolderId';
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

  folders
    .command('move <workflow-id-or-path> <folder-id-or-name>')
    .description('Move a workflow to a folder directly in n8n database')
    .option('--db-url <url>', 'n8n PostgreSQL database connection URL')
    .action(async (workflowIdOrPath, folderIdOrName, options) => {
      try {
        const { dbUrl, repoRoot, localDir } = getConnectionInfo(options);
        if (!dbUrl) {
          throw new Error('Database URL (dbUrl) is required to move workflows. Configure it globally or pass via --db-url.');
        }

        let workflowId = workflowIdOrPath;
        if (repoRoot) {
          const workflowsDir = path.join(repoRoot, localDir, 'workflows');
          const resolvedTarget = resolveAndConvertTarget(workflowIdOrPath, workflowsDir);
          const fullPath = path.resolve(resolvedTarget);
          if (fs.existsSync(fullPath)) {
            const relativePath = path.relative(workflowsDir, fullPath).replace(/\\/g, '/');
            const syncState = loadSyncState(repoRoot, localDir);
            const entry = syncState.workflows[relativePath];
            if (entry) {
              workflowId = entry.id;
            }
          }
        }

        const pgModule = pg as any;
        const ClientClass = pgModule.Client || pgModule.default?.Client || pgModule;
        const client = new ClientClass({
          connectionString: dbUrl,
          ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false')) ? false : { rejectUnauthorized: false }
        });

        await client.connect();
        try {
          // Find workflow
          const wfRes = await client.query(
            'SELECT id, name FROM workflow_entity WHERE id = $1 OR name = $2;',
            [workflowId, workflowId]
          );
          if (wfRes.rows.length === 0) {
            throw new Error(`Workflow '${workflowId}' not found in database.`);
          }
          const actualWfId = wfRes.rows[0].id;
          const wfName = wfRes.rows[0].name;

          // Find folder
          let targetFolderId: string | null = null;
          let targetFolderName = 'root';
          const isRoot = ['root', 'null', 'none', 'undefined'].includes(folderIdOrName.toLowerCase());
          
          if (!isRoot) {
            const folderRes = await client.query(
              'SELECT id, name FROM folder WHERE id = $1 OR name = $2;',
              [folderIdOrName, folderIdOrName]
            );
            if (folderRes.rows.length === 0) {
              throw new Error(`Folder '${folderIdOrName}' not found in database.`);
            }
            targetFolderId = folderRes.rows[0].id;
            targetFolderName = folderRes.rows[0].name;
          }

          const folderCol = await getWorkflowFolderColumn(client);
          await client.query(
            `UPDATE workflow_entity SET "${folderCol}" = $1, "updatedAt" = NOW() WHERE id = $2;`,
            [targetFolderId, actualWfId]
          );

          output.log(`Successfully moved workflow '${wfName}' (ID: ${actualWfId}) to folder '${targetFolderName}' (ID: ${targetFolderId || 'root'})`);
        } finally {
          await client.end();
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  folders
    .command('delete <folder-id-or-name>')
    .description('Delete a folder from n8n database')
    .option('--no-cascade', 'move workflows and child folders to root instead of deleting them')
    .option('--db-url <url>', 'n8n PostgreSQL database connection URL')
    .action(async (folderIdOrName, options) => {
      try {
        const { dbUrl } = getConnectionInfo(options);
        if (!dbUrl) {
          throw new Error('Database URL (dbUrl) is required to delete folders. Configure it globally or pass via --db-url.');
        }

        const pgModule = pg as any;
        const ClientClass = pgModule.Client || pgModule.default?.Client || pgModule;
        const client = new ClientClass({
          connectionString: dbUrl,
          ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false')) ? false : { rejectUnauthorized: false }
        });

        await client.connect();
        try {
          // Find folder ID
          const folderRes = await client.query(
            'SELECT id, name FROM folder WHERE id = $1 OR name = $2;',
            [folderIdOrName, folderIdOrName]
          );
          if (folderRes.rows.length === 0) {
            throw new Error(`Folder '${folderIdOrName}' not found in database.`);
          }
          const folderId = folderRes.rows[0].id;
          const folderName = folderRes.rows[0].name;

          const folderCol = await getWorkflowFolderColumn(client);

          // Get all folders in the subtree (including the folder itself)
          const allFolderIds = [folderId];
          let searchQueue = [folderId];
          while (searchQueue.length > 0) {
            const currentId = searchQueue.shift()!;
            const subFoldersRes = await client.query(
              'SELECT id FROM folder WHERE "parentFolderId" = $1;',
              [currentId]
            );
            for (const row of subFoldersRes.rows) {
              allFolderIds.push(row.id);
              searchQueue.push(row.id);
            }
          }

          // If no-cascade is set, we move workflows/subfolders to root
          if (options.cascade === false) {
            output.log(`Moving workflows and subfolders in folder tree of '${folderName}' to root...`);
            // Set all workflows in the subtree folders to parentFolderId = null
            await client.query(
              `UPDATE workflow_entity SET "${folderCol}" = NULL WHERE "${folderCol}" = ANY($1);`,
              [allFolderIds]
            );
            // For child folders of the main folder, set their parentFolderId to null
            await client.query(
              'UPDATE folder SET "parentFolderId" = NULL WHERE "parentFolderId" = $1;',
              [folderId]
            );
            // Delete the main folder itself
            await client.query('DELETE FROM folder WHERE id = $1;', [folderId]);
            output.log(`Successfully deleted folder '${folderName}' (workflows/subfolders moved to root).`);
          } else {
            // Cascade delete everything in the subtree
            output.log(`Cascade deleting workflows and subfolders in folder tree of '${folderName}'...`);
            // Find all workflows in the folders subtree
            const wfRes = await client.query(
              `SELECT id, name FROM workflow_entity WHERE "${folderCol}" = ANY($1);`,
              [allFolderIds]
            );
            const wfIds = wfRes.rows.map((r: any) => r.id);

            if (wfIds.length > 0) {
              output.log(`Deleting execution data and workflow entities for ${wfIds.length} workflows...`);
              await client.query('DELETE FROM execution_entity WHERE "workflowId" = ANY($1);', [wfIds]);
              await client.query('DELETE FROM shared_workflow WHERE "workflowId" = ANY($1);', [wfIds]);
              await client.query('DELETE FROM workflow_dependency WHERE "workflowId" = ANY($1);', [wfIds]);
              await client.query('DELETE FROM workflows_tags WHERE "workflowId" = ANY($1);', [wfIds]);
              await client.query('DELETE FROM workflow_entity WHERE id = ANY($1);', [wfIds]);
            }

            // Delete folders in reverse order (bottom-up) to avoid foreign key violations
            for (let i = allFolderIds.length - 1; i >= 0; i--) {
              await client.query('DELETE FROM folder WHERE id = $1;', [allFolderIds[i]]);
            }
            output.log(`Successfully deleted folder '${folderName}' and all cascade contents.`);
          }
        } finally {
          await client.end();
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  folders
    .command('set-parent <folder-id-or-name> <parent-folder-id-or-name>')
    .description('Set parent folder for a folder directly in n8n database')
    .option('--db-url <url>', 'n8n PostgreSQL database connection URL')
    .action(async (folderIdOrName, parentFolderIdOrName, options) => {
      try {
        const { dbUrl } = getConnectionInfo(options);
        if (!dbUrl) {
          throw new Error('Database URL (dbUrl) is required to set parent folder. Configure it globally or pass via --db-url.');
        }

        const pgModule = pg as any;
        const ClientClass = pgModule.Client || pgModule.default?.Client || pgModule;
        const client = new ClientClass({
          connectionString: dbUrl,
          ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false')) ? false : { rejectUnauthorized: false }
        });

        await client.connect();
        try {
          // Find folder ID
          const folderRes = await client.query(
            'SELECT id, name FROM folder WHERE id = $1 OR name = $2;',
            [folderIdOrName, folderIdOrName]
          );
          if (folderRes.rows.length === 0) {
            throw new Error(`Folder '${folderIdOrName}' not found in database.`);
          }
          const folderId = folderRes.rows[0].id;
          const folderName = folderRes.rows[0].name;

          // Find parent folder ID
          let parentFolderId: string | null = null;
          let parentFolderName = 'root';
          const isRoot = ['root', 'null', 'none', 'undefined'].includes(parentFolderIdOrName.toLowerCase());

          if (!isRoot) {
            const parentRes = await client.query(
              'SELECT id, name FROM folder WHERE id = $1 OR name = $2;',
              [parentFolderIdOrName, parentFolderIdOrName]
            );
            if (parentRes.rows.length === 0) {
              throw new Error(`Parent folder '${parentFolderIdOrName}' not found in database.`);
            }
            parentFolderId = parentRes.rows[0].id;
            parentFolderName = parentRes.rows[0].name;
          }

          // Prevent setting parent folder to itself
          if (folderId === parentFolderId) {
            throw new Error('A folder cannot be its own parent.');
          }

          await client.query(
            'UPDATE folder SET "parentFolderId" = $1, "updatedAt" = NOW() WHERE id = $2;',
            [parentFolderId, folderId]
          );

          output.log(`Successfully set parent of folder '${folderName}' (ID: ${folderId}) to '${parentFolderName}' (ID: ${parentFolderId || 'root'})`);
        } finally {
          await client.end();
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
