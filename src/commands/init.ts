import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { saveConfig, N8nCliConfig, saveGlobalConfig, loadGlobalConfig } from '../config.js';
import { withMcp } from '../mcp-client.js';
import * as output from '../output.js';
import { writeSkillFile } from './import-skill.js';
import { saveDefaultStandards } from '../lint-engine.js';
import readline from 'readline';

function askQuestion(query: string, defaultValue = ''): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const prompt = defaultValue ? `${query} [${defaultValue}]: ` : `${query}: `;
  return new Promise(resolve => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

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
    .option('--ref-env <name>', 'environment name for reference workflows')
    .option('--mcp-command <cmd>', 'MCP server start command')
    .option('--dir <path>', 'local directory for n8n files (defaults to n8n)', 'n8n')
    .option('--interactive', 'run interactive configuration wizard', false)
    .action(async (options) => {
      const repoRoot = process.cwd();

      let envName = '';
      let instanceUrl = options.url;
      let accessToken = options.accessToken;
      let apiKey = options.apiKey;
      let dbUrl = options.dbUrl;
      let projectId = options.projectId;
      let folderId = options.folderId;
      let refProjectId = options.refProjectId;
      let refFolderId = options.refFolderId;
      let refEnv = options.refEnv;
      const localDir = options.dir || 'n8n';

      let projectName = 'Personal';
      let folderName: string | undefined = undefined;
      let refProjectName = '';
      let refFolderName: string | undefined = undefined;

      if (options.interactive) {
        output.log('Starting interactive setup wizard...');
        const globalConfig = loadGlobalConfig();
        const defaultEnv = options.env || 'development';
        envName = await askQuestion('Environment name', defaultEnv);

        const envConfig = globalConfig.environments?.[envName] || {};

        const defaultUrl = options.url || envConfig.instanceUrl || globalConfig.instanceUrl || '';
        instanceUrl = await askQuestion('n8n instance URL', defaultUrl);

        const defaultToken = options.accessToken || envConfig.accessToken || globalConfig.accessToken || '';
        accessToken = await askQuestion('n8n access token', defaultToken);

        const defaultApiKey = options.apiKey || envConfig.apiKey || globalConfig.apiKey || '';
        apiKey = await askQuestion('n8n REST API key (optional)', defaultApiKey);

        const defaultDbUrl = options.dbUrl || envConfig.dbUrl || globalConfig.dbUrl || '';
        dbUrl = await askQuestion('PostgreSQL database connection URL (optional)', defaultDbUrl);

        const mcpCommand = options.mcpCommand || envConfig.mcpCommand || globalConfig.mcpCommand || 'npx -y n8n-mcp';

        if (!instanceUrl) {
          output.error('Error: n8n instance URL is required.');
          process.exit(1);
        }
        if (!accessToken) {
          output.error('Error: n8n access token is required.');
          process.exit(1);
        }

        output.log('\nConnecting to n8n instance to fetch projects...');
        try {
          await withMcp(mcpCommand, accessToken, async (mcp) => {
            const projectsRes = await mcp.callToolAndGetJson('search_projects', {});
            const projects = Array.isArray(projectsRes) ? projectsRes : (projectsRes.projects || projectsRes.data || []);

            if (projects.length === 0) {
              output.log('No projects found. Defaulting to "personal".');
              projectId = 'personal';
            } else {
              output.log('\nAvailable Projects:');
              projects.forEach((p: any, idx: number) => {
                output.log(`  ${idx + 1}) ${p.name} (${p.type || 'team'}, ID: ${p.id})`);
              });
              const projSelection = await askQuestion(`Select project (1-${projects.length}) [1]`, '1');
              const selIdx = parseInt(projSelection) - 1;
              const selectedProj = projects[selIdx] || projects[0];
              projectId = selectedProj.id;
              projectName = selectedProj.name;
              output.log(`Selected project: ${projectName} (${projectId})`);
            }

            if (projectId && projectId !== 'personal') {
              const foldersRes = await mcp.callToolAndGetJson('search_folders', { projectId });
              const folders = Array.isArray(foldersRes) ? foldersRes : (foldersRes.folders || foldersRes.data || []);
              if (folders.length > 0) {
                output.log('\nAvailable Folders:');
                output.log('  1) None (Sync with project root)');
                folders.forEach((f: any, idx: number) => {
                  output.log(`  ${idx + 2}) ${f.name} (ID: ${f.id})`);
                });
                const folderSelection = await askQuestion(`Select folder (1-${folders.length + 1}) [1]`, '1');
                const fSelIdx = parseInt(folderSelection) - 1;
                if (fSelIdx > 0) {
                  const selectedFolder = folders[fSelIdx - 1];
                  folderId = selectedFolder.id;
                  folderName = selectedFolder.name;
                  output.log(`Selected folder: ${folderName} (${folderId})`);
                } else {
                  output.log('Selected folder: None (Sync with project root)');
                }
              }
            }

            const configureRef = await askQuestion('\nConfigure a reference workflows project? (y/n) [n]', 'n');
            if (configureRef.toLowerCase() === 'y') {
              output.log('\nAvailable Projects for References:');
              projects.forEach((p: any, idx: number) => {
                output.log(`  ${idx + 1}) ${p.name} (${p.type || 'team'}, ID: ${p.id})`);
              });
              const refProjSelection = await askQuestion(`Select reference project (1-${projects.length}) [1]`, '1');
              const refSelIdx = parseInt(refProjSelection) - 1;
              const selectedRefProj = projects[refSelIdx] || projects[0];
              refProjectId = selectedRefProj.id;
              refProjectName = selectedRefProj.name;

              if (refProjectId && refProjectId !== 'personal') {
                const refFoldersRes = await mcp.callToolAndGetJson('search_folders', { projectId: refProjectId });
                const refFolders = Array.isArray(refFoldersRes) ? refFoldersRes : (refFoldersRes.folders || refFoldersRes.data || []);
                if (refFolders.length > 0) {
                  output.log('\nAvailable Folders for References:');
                  output.log('  1) None (Sync with project root)');
                  refFolders.forEach((f: any, idx: number) => {
                    output.log(`  ${idx + 2}) ${f.name} (ID: ${f.id})`);
                  });
                  const refFolderSelection = await askQuestion(`Select reference folder (1-${refFolders.length + 1}) [1]`, '1');
                  const refFSelIdx = parseInt(refFolderSelection) - 1;
                  if (refFSelIdx > 0) {
                    const selectedRefFolder = refFolders[refFSelIdx - 1];
                    refFolderId = selectedRefFolder.id;
                    refFolderName = selectedRefFolder.name;
                  }
                }
              }
            }
          }, instanceUrl);
        } catch (err) {
          output.warn(`Failed to connect interactively: ${err instanceof Error ? err.message : String(err)}`);
          output.warn('Continuing with manual configuration...');
        }
      } else {
        // Non-interactive path
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

        const globalConfig = loadGlobalConfig();
        const envConfig = globalConfig.environments?.[envName] || {};

        instanceUrl = options.url || envConfig.instanceUrl || globalConfig.instanceUrl;
        accessToken = options.accessToken || envConfig.accessToken || globalConfig.accessToken;
        apiKey = options.apiKey || envConfig.apiKey || globalConfig.apiKey;
        dbUrl = options.dbUrl || envConfig.dbUrl || globalConfig.dbUrl;

        projectId = options.projectId;
        folderId = options.folderId;
        refProjectId = options.refProjectId;
        refFolderId = options.refFolderId;
        refEnv = options.refEnv;
      }

      output.log(`Initializing n8ncli in current repository for environment '${envName}' in directory '${localDir}'...`);

      const mcpCommand = options.mcpCommand || loadGlobalConfig().environments?.[envName]?.mcpCommand || loadGlobalConfig().mcpCommand || 'npx -y n8n-mcp';

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

      // 4. Connect to MCP to verify connection and fetch Project/Folder names (if not already fetched during interactive setup)
      if (!options.interactive) {
        try {
          output.log('Verifying connection with n8n instance...');
          await withMcp(mcpCommand, accessToken, async (mcp) => {
            // Resolve project names if IDs provided
            if (projectId) {
              const projects = await mcp.callToolAndGetJson('search_projects', {});
              const projList = Array.isArray(projects) ? projects : (projects.projects || projects.data || []);
              const matchedProj = projList.find((p: any) => p.id === projectId);
              if (matchedProj) {
                projectName = matchedProj.name;
              } else {
                output.warn(`Could not find project with ID: ${projectId}. Using 'Personal' as fallback name.`);
              }

              if (folderId) {
                const folders = await mcp.callToolAndGetJson('search_folders', { projectId: projectId });
                const folderList = Array.isArray(folders) ? folders : (folders.folders || folders.data || []);
                const matchedFolder = folderList.find((f: any) => f.id === folderId);
                if (matchedFolder) {
                  folderName = matchedFolder.name;
                } else {
                  output.warn(`Could not find folder with ID: ${folderId} in project ${projectId}.`);
                }
              }
            }

            // Resolve reference project names if IDs provided (using main mcp connection if same environment)
            if (refProjectId && (!refEnv || refEnv === envName)) {
              const projects = await mcp.callToolAndGetJson('search_projects', {});
              const projList = Array.isArray(projects) ? projects : (projects.projects || projects.data || []);
              const matchedProj = projList.find((p: any) => p.id === refProjectId);
              if (matchedProj) {
                refProjectName = matchedProj.name;
              } else {
                output.warn(`Could not find reference project with ID: ${refProjectId}.`);
              }

              if (refFolderId) {
                const folders = await mcp.callToolAndGetJson('search_folders', { projectId: refProjectId });
                const folderList = Array.isArray(folders) ? folders : (folders.folders || folders.data || []);
                const matchedFolder = folderList.find((f: any) => f.id === refFolderId);
                if (matchedFolder) {
                  refFolderName = matchedFolder.name;
                } else {
                  output.warn(`Could not find reference folder with ID: ${refFolderId} in project ${refProjectId}.`);
                }
              }
            }
          }, instanceUrl);

          // If an independent refEnv is specified and is different from envName
          if (refProjectId && refEnv && refEnv !== envName) {
            const globalConfig = loadGlobalConfig();
            const refEnvConfig = globalConfig.environments?.[refEnv] || {};
            const refMcpCommand = refEnvConfig.mcpCommand || globalConfig.mcpCommand || 'npx -y n8n-mcp';
            const refAccessToken = refEnvConfig.accessToken || globalConfig.accessToken;
            const refInstanceUrl = refEnvConfig.instanceUrl || globalConfig.instanceUrl;

            if (refAccessToken) {
              output.log(`Verifying reference connection with independent environment '${refEnv}'...`);
              try {
                await withMcp(refMcpCommand, refAccessToken, async (refMcp) => {
                  const projects = await refMcp.callToolAndGetJson('search_projects', {});
                  const projList = Array.isArray(projects) ? projects : (projects.projects || projects.data || []);
                  const matchedProj = projList.find((p: any) => p.id === refProjectId);
                  if (matchedProj) {
                    refProjectName = matchedProj.name;
                  } else {
                    output.warn(`Could not find reference project with ID: ${refProjectId} in environment ${refEnv}.`);
                  }

                  if (refFolderId) {
                    const folders = await refMcp.callToolAndGetJson('search_folders', { projectId: refProjectId });
                    const folderList = Array.isArray(folders) ? folders : (folders.folders || folders.data || []);
                    const matchedFolder = folderList.find((f: any) => f.id === refFolderId);
                    if (matchedFolder) {
                      refFolderName = matchedFolder.name;
                    } else {
                      output.warn(`Could not find reference folder with ID: ${refFolderId} in reference project ${refProjectId}.`);
                    }
                  }
                }, refInstanceUrl);
              } catch (err) {
                output.warn(`Could not verify connection to reference environment '${refEnv}' via MCP: ${err instanceof Error ? err.message : String(err)}`);
              }
            } else {
              output.warn(`Reference environment '${refEnv}' is not configured in global environments. Cannot verify reference project/folder.`);
            }
          }

          output.log('Successfully connected to n8n instance and validated settings.');
        } catch (err) {
          output.warn(`Could not verify connection via MCP: ${err instanceof Error ? err.message : String(err)}`);
          output.warn('Configuration will still be written, but verify your instance URL, access token, and command line.');
        }
      }

      // 5. Write config file
      const config: N8nCliConfig = {
        env: envName,
        localDir: localDir,
        projectId: projectId || 'personal',
        projectName,
        folderId,
        folderName,
      };

      if (refProjectId) {
        config.references = {
          projectId: refProjectId,
          projectName: refProjectName || 'References',
          folderId: refFolderId,
          folderName: refFolderName,
        };
        if (refEnv) {
          config.references.env = refEnv;
        }
      }

      saveConfig(repoRoot, config);
      output.log(`Configuration saved to: ${localDir}/config/n8n-cli.json`);

      // Automatically write the agent skill to .agents/skills/n8n/SKILL.md
      try {
        const relativePath = writeSkillFile(repoRoot);
        output.log(`Automatically imported n8n CLI skill to: ${relativePath}`);
      } catch (err) {
        output.warn(`Could not automatically create agent skill: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Automatically generate n8n-standards.json if not present
      try {
        saveDefaultStandards(repoRoot);
        output.log(`Initialized default style standards in ${localDir}/config/n8n-standards.json`);
      } catch (err) {
        output.warn(`Could not initialize n8n-standards.json: ${err instanceof Error ? err.message : String(err)}`);
      }

      output.log('Initialization complete! You can now run `n8ncli pull` to sync workflows.');
    });
}

