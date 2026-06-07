import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { saveConfig, N8nCliConfig } from '../config.js';
import { withMcp } from '../mcp-client.js';
import * as output from '../output.js';

export function initCommand(program: Command) {
  program
    .command('init')
    .description('Initialize n8n CLI configuration in the current repository')
    .requiredOption('--url <url>', 'n8n instance URL (e.g., https://n8n.example.com)')
    .requiredOption('--access-token <token>', 'n8n access token')
    .option('--api-key <key>', 'n8n REST API key')
    .option('--env <name>', 'environment name (e.g., development, production)', 'development')
    .option('--project-id <id>', 'n8n project ID to sync with')
    .option('--folder-id <id>', 'n8n folder ID to sync with')
    .option('--ref-project-id <id>', 'n8n reference project ID')
    .option('--ref-folder-id <id>', 'n8n reference folder ID')
    .option('--mcp-command <cmd>', 'MCP server start command', 'n8n mcp')
    .action(async (options) => {
      const repoRoot = process.cwd();

      output.log('Initializing n8ncli in current repository...');

      // 1. Create directories
      const configDir = path.join(repoRoot, 'n8n', 'config');
      const workflowsDir = path.join(repoRoot, 'n8n', 'workflows');
      const referencesDir = path.join(repoRoot, 'n8n', 'references');

      fs.mkdirSync(configDir, { recursive: true });
      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.mkdirSync(referencesDir, { recursive: true });

      // 2. Append/Write .env
      const envPath = path.join(repoRoot, '.env');
      let envContent = '';
      if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf-8');
      }

      const envLines = [];
      if (!envContent.includes('N8N_ACCESS_TOKEN')) {
        envLines.push(`N8N_ACCESS_TOKEN=${options.accessToken}`);
      }
      if (options.apiKey && !envContent.includes('N8N_API_KEY')) {
        envLines.push(`N8N_API_KEY=${options.apiKey}`);
      }

      if (envLines.length > 0) {
        fs.appendFileSync(envPath, `\n# n8ncli configurations\n${envLines.join('\n')}\n`, 'utf-8');
        output.log('Updated .env file with n8n credentials.');
      }

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
      if (!gitignoreContent.includes('n8n/config/sync-state.json')) {
        gitignoreLines.push('n8n/config/sync-state.json');
      }
      if (!gitignoreContent.includes('n8n/references/')) {
        gitignoreLines.push('n8n/references/');
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
        await withMcp(options.mcpCommand, options.accessToken, async (mcp) => {
          // Resolve project names if IDs provided
          if (options.projectId) {
            const projects = await mcp.callToolAndGetJson('search_projects', {});
            const projList = Array.isArray(projects) ? projects : (projects.projects || []);
            const matchedProj = projList.find((p: any) => p.id === options.projectId);
            if (matchedProj) {
              projectName = matchedProj.name;
            } else {
              output.warn(`Could not find project with ID: ${options.projectId}. Using 'Personal' as fallback name.`);
            }

            if (options.folderId) {
              const folders = await mcp.callToolAndGetJson('search_folders', { projectId: options.projectId });
              const folderList = Array.isArray(folders) ? folders : (folders.folders || []);
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
            const projList = Array.isArray(projects) ? projects : (projects.projects || []);
            const matchedProj = projList.find((p: any) => p.id === options.refProjectId);
            if (matchedProj) {
              refProjectName = matchedProj.name;
            } else {
              output.warn(`Could not find reference project with ID: ${options.refProjectId}.`);
            }

            if (options.refFolderId) {
              const folders = await mcp.callToolAndGetJson('search_folders', { projectId: options.refProjectId });
              const folderList = Array.isArray(folders) ? folders : (folders.folders || []);
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
        instanceUrl: options.url,
        environmentName: options.env,
        projectId: options.projectId || 'personal',
        projectName,
        folderId: options.folderId,
        folderName,
        mcpServerCommand: options.mcpCommand,
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
      output.log(`Configuration saved to: n8n/config/n8n-cli.json`);
      output.log('Initialization complete! You can now run `n8ncli pull` to sync workflows.');
    });
}
