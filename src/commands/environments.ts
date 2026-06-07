import { Command } from 'commander';
import { loadGlobalConfig } from '../config.js';
import * as output from '../output.js';

export function environmentsCommand(program: Command) {
  program
    .command('environments')
    .alias('envs')
    .description('List all configured n8n environments from global configuration')
    .action(() => {
      try {
        const globalConfig = loadGlobalConfig();
        const environments = globalConfig.environments || {};
        
        const envList = Object.entries(environments).map(([name, env]) => ({
          name,
          instanceUrl: env.instanceUrl || 'N/A',
          mcpCommand: env.mcpCommand || 'N/A',
          hasDbUrl: !!env.dbUrl,
          hasAccessToken: !!env.accessToken,
          hasApiKey: !!env.apiKey,
        }));

        // Handle JSON output mode
        if (output.getJsonMode()) {
          console.log(JSON.stringify(envList, null, 2));
          return;
        }

        if (envList.length === 0) {
          output.log('No environments configured in global settings (~/.n8ncli-global.json).');
          output.log('Run `n8ncli init` to initialize and configure an environment.');
          return;
        }

        const headers = ['Environment', 'Instance URL', 'MCP Command', 'DB Configured', 'Auth Token', 'API Key'];
        const rows = envList.map(env => [
          env.name,
          env.instanceUrl,
          env.mcpCommand,
          env.hasDbUrl ? 'Yes' : 'No',
          env.hasAccessToken ? 'Yes' : 'No',
          env.hasApiKey ? 'Yes' : 'No'
        ]);

        output.table(headers, rows);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
