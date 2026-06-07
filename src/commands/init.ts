import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { saveConfig, N8nCliConfig, saveGlobalConfig, loadGlobalConfig } from '../config.js';
import { withMcp } from '../mcp-client.js';
import * as output from '../output.js';

export function initCommand(program: Command) {
  program
    .command('init')
    .description('Initialize n8n CLI configuration in the current repository')
    .option('--url <url>', 'n8n instance URL (e.g., https://n8n.example.com)')
    .option('--access-token <token>', 'n8n access token')
    .option('--api-key <key>', 'n8n REST API key')
    .option('--db-url <url>', 'n8n PostgreSQL database connection URL (stored globally)')
    .option('--env <name>', 'environment name (e.g., development, production)', 'development')
    .option('--project-id <id>', 'n8n project ID to sync with')
    .option('--folder-id <id>', 'n8n folder ID to sync with')
    .option('--ref-project-id <id>', 'n8n reference project ID')
    .option('--ref-folder-id <id>', 'n8n reference folder ID')
    .option('--mcp-command <cmd>', 'MCP server start command', 'npx -y n8n-mcp')
    .option('--dir <path>', 'local directory for n8n files (defaults to n8n)', 'n8n')
    .action(async (options) => {
      const repoRoot = process.cwd();

      let envName = '';
      const envArgIndex = process.argv.indexOf('--env');
      if (envArgIndex !== -1 && envArgIndex + 1 < process.argv.length) {
        envName = process.argv[envArgIndex + 1];
      } else {
        const envArg = process.argv.find(arg => arg.startsWith('--env='));
        if (envArg) {
          envName = envArg.split('=')[1];
        }
      }
      if (!envName) {
        envName = options.env || 'development';
      }
      const localDir = options.dir || 'n8n';
      output.log(`Initializing n8ncli in current repository for environment '${envName}' in directory '${localDir}'...`);

      // Load global config to check for existing credentials in the selected environment
      const globalConfig = loadGlobalConfig();
      const envConfig = globalConfig.environments?.[envName] || {};
      
      const instanceUrl = options.url || envConfig.instanceUrl || globalConfig.instanceUrl;
      const accessToken = options.accessToken || envConfig.accessToken || globalConfig.accessToken;
      const apiKey = options.apiKey || envConfig.apiKey || globalConfig.apiKey;
      const dbUrl = options.dbUrl || envConfig.dbUrl || globalConfig.dbUrl;
      const mcpCommand = options.mcpCommand || envConfig.mcpCommand || globalConfig.mcpCommand || 'npx -y n8n-mcp';

      if (!instanceUrl) {
        output.error('Error: n8n instance URL is required. Provide it via --url flag or configure it globally.');
        process.exit(1);
      }

      if (!accessToken) {
        output.error('Error: n8n access token is required. Provide it via --access-token flag or configure it globally.');
        process.exit(1);
      }

      // Save global configs under the selected environment name
      const globalUpdates: any = {};
      globalUpdates.instanceUrl = instanceUrl;
      globalUpdates.mcpCommand = mcpCommand;
      if (dbUrl) globalUpdates.dbUrl = dbUrl;
      if (accessToken) globalUpdates.accessToken = accessToken;
      if (apiKey) globalUpdates.apiKey = apiKey;
      
      saveGlobalConfig(globalUpdates, envName);
      output.log(`Saved global system-level configurations for environment '${envName}'.`);

      // 1. Create directories
      const configDir = path.join(repoRoot, localDir, 'config');
      const workflowsDir = path.join(repoRoot, localDir, 'workflows');
      const referencesDir = path.join(repoRoot, localDir, 'references');

      fs.mkdirSync(configDir, { recursive: true });
      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.mkdirSync(referencesDir, { recursive: true });

      // 3. Update .gitignore
      const gitignorePath = path.join(repoRoot, '.gitignore');
      let gitignoreContent = '';
      if (fs.existsSync(gitignorePath)) {
        gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
      }

      const gitignoreLines = [];
      if (!gitignoreContent.includes('.env')) {
        gitignoreLines.push('.env');
      }
      if (!gitignoreContent.includes(`${localDir}/config/sync-state.json`)) {
        gitignoreLines.push(`${localDir}/config/sync-state.json`);
      }
      if (!gitignoreContent.includes(`${localDir}/references/`)) {
        gitignoreLines.push(`${localDir}/references/`);
      }

      if (gitignoreLines.length > 0) {
        fs.appendFileSync(gitignorePath, `\n# n8ncli ignored files\n${gitignoreLines.join('\n')}\n`, 'utf-8');
        output.log('Updated .gitignore with n8ncli patterns.');
      }

      // 4. Connect to MCP to verify connection and fetch Project/Folder names
      let projectName = 'Personal';
      let folderName: string | undefined = undefined;
      let refProjectName = '';
      let refFolderName: string | undefined = undefined;

      try {
        output.log('Verifying connection with n8n instance...');
        await withMcp(mcpCommand, accessToken, async (mcp) => {
          // Resolve project names if IDs provided
          if (options.projectId) {
            const projects = await mcp.callToolAndGetJson('search_projects', {});
            const projList = Array.isArray(projects) ? projects : (projects.projects || projects.data || []);
            const matchedProj = projList.find((p: any) => p.id === options.projectId);
            if (matchedProj) {
              projectName = matchedProj.name;
            } else {
              output.warn(`Could not find project with ID: ${options.projectId}. Using 'Personal' as fallback name.`);
            }

            if (options.folderId) {
              const folders = await mcp.callToolAndGetJson('search_folders', { projectId: options.projectId });
              const folderList = Array.isArray(folders) ? folders : (folders.folders || folders.data || []);
              const matchedFolder = folderList.find((f: any) => f.id === options.folderId);
              if (matchedFolder) {
                folderName = matchedFolder.name;
              } else {
                output.warn(`Could not find folder with ID: ${options.folderId} in project ${options.projectId}.`);
              }
            }
          }

          // Resolve reference project names if IDs provided
          if (options.refProjectId) {
            const projects = await mcp.callToolAndGetJson('search_projects', {});
            const projList = Array.isArray(projects) ? projects : (projects.projects || projects.data || []);
            const matchedProj = projList.find((p: any) => p.id === options.refProjectId);
            if (matchedProj) {
              refProjectName = matchedProj.name;
            } else {
              output.warn(`Could not find reference project with ID: ${options.refProjectId}.`);
            }

            if (options.refFolderId) {
              const folders = await mcp.callToolAndGetJson('search_folders', { projectId: options.refProjectId });
              const folderList = Array.isArray(folders) ? folders : (folders.folders || folders.data || []);
              const matchedFolder = folderList.find((f: any) => f.id === options.refFolderId);
              if (matchedFolder) {
                refFolderName = matchedFolder.name;
              } else {
                output.warn(`Could not find reference folder with ID: ${options.refFolderId} in project ${options.refProjectId}.`);
              }
            }
          }
        });
        output.log('Successfully connected to n8n instance and validated settings.');
      } catch (err) {
        output.warn(`Could not verify connection via MCP: ${err instanceof Error ? err.message : String(err)}`);
        output.warn('Configuration will still be written, but verify your instance URL, access token, and command line.');
      }

      // 5. Write config file
      const config: N8nCliConfig = {
        env: envName,
        localDir: localDir,
        projectId: options.projectId || 'personal',
        projectName,
        folderId: options.folderId,
        folderName,
      };

      if (options.refProjectId) {
        config.references = {
          projectId: options.refProjectId,
          projectName: refProjectName || 'References',
          folderId: options.refFolderId,
          folderName: refFolderName,
        };
      }

      saveConfig(repoRoot, config);
      output.log(`Configuration saved to: ${localDir}/config/n8n-cli.json`);
      output.log('Initialization complete! You can now run `n8ncli pull` to sync workflows.');
    });
}
