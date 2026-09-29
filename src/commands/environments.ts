import { Command } from 'commander';
import fs from 'fs';
import readline from 'readline';
import pg from 'pg';
import { loadGlobalConfig, saveGlobalConfig, getGlobalConfigPath } from '../config.js';
import { withMcp } from '../mcp-client.js';
import * as output from '../output.js';

function createPrompter() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const it = rl[Symbol.asyncIterator]();
  return {
    async ask(query: string, defaultValue = ''): Promise<string> {
      const prompt = defaultValue ? `${query} [${defaultValue}]: ` : `${query}: `;
      if (process.stdin.isTTY) {
        return new Promise(resolve => {
          rl.question(prompt, (answer) => {
            resolve(answer.trim() || defaultValue);
          });
        });
      } else {
        process.stdout.write(prompt);
        const res = await it.next();
        const line = res.done ? '' : (res.value || '');
        return line.trim() || defaultValue;
      }
    },
    close() {
      rl.close();
    }
  };
}

export type SubsystemTestStatus = 'SUCCESS' | 'FAILURE' | 'SKIPPED';

export interface TestResult {
  success: boolean;
  status: SubsystemTestStatus;
  message: string;
}

export async function testRestApi(instanceUrl: string, apiKey: string): Promise<TestResult> {
  if (!instanceUrl) return { success: false, status: 'FAILURE', message: 'Instance URL not configured' };
  if (!apiKey) return { success: false, status: 'SKIPPED', message: 'Not configured (optional)' };

  const cleanUrl = instanceUrl.replace(/\/$/, '');
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${cleanUrl}/api/v1/workflows?limit=1`, {
      headers: { 'X-N8N-API-KEY': apiKey },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      return { success: true, status: 'SUCCESS', message: 'Connected successfully' };
    } else {
      return { success: false, status: 'FAILURE', message: `Status ${res.status} (${res.statusText})` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, status: 'FAILURE', message: msg.includes('aborted') ? 'Connection timed out (5s)' : msg };
  }
}

export async function testMcp(mcpCommand: string, accessToken: string, instanceUrl: string): Promise<TestResult> {
  if (!accessToken) return { success: false, status: 'FAILURE', message: 'Access token not configured' };

  try {
    // Attempt connecting via MCP and executing search_projects
    await withMcp(mcpCommand, accessToken, async (mcp) => {
      await mcp.callToolAndGetJson('search_projects', { limit: 1 });
    }, instanceUrl);
    return { success: true, status: 'SUCCESS', message: 'Connected successfully' };
  } catch (err) {
    return { success: false, status: 'FAILURE', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function testDatabase(dbUrl: string): Promise<TestResult> {
  if (!dbUrl) return { success: false, status: 'SKIPPED', message: 'Not configured (optional)' };

  const pgClient = pg as any;
  const ClientClass = pgClient.Client || pgClient.default?.Client || pgClient;
  const client = new ClientClass({
    connectionString: dbUrl,
    connectionTimeoutMillis: 5000,
    ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false')) ? false : { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    await client.query('SELECT 1;');
    return { success: true, status: 'SUCCESS', message: 'Connected successfully' };
  } catch (err) {
    return { success: false, status: 'FAILURE', message: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      await client.end();
    } catch (e) {}
  }
}

export const testPg = testDatabase;

async function listEnvironments() {
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

  if (output.getJsonMode()) {
    console.log(JSON.stringify(envList, null, 2));
    return;
  }

  if (envList.length === 0) {
    output.log('No environments configured in global settings (~/.n8ncli-global.json).');
    output.log('Run `n8ncli env edit <name>` to configure one.');
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
}

export function environmentsCommand(program: Command) {
  const envs = program
    .command('environments')
    .alias('envs')
    .alias('env')
    .description('Manage and test n8n environments')
    .option('--json', 'output raw JSON format');

  // Default action: List environments
  envs.action(async () => {
    try {
      await listEnvironments();
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

  envs
    .command('list')
    .description('List all configured n8n environments')
    .option('--json', 'output raw JSON format')
    .action(async () => {
      try {
        await listEnvironments();
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  envs
    .command('test [name]')
    .description('Test API, MCP, and Database connections for an environment (or all environments if name is omitted)')
    .action(async (name) => {
      try {
        const globalConfig = loadGlobalConfig();
        const environments = globalConfig.environments || {};
        
        let envsToTest: string[] = [];
        if (name) {
          if (!environments[name]) {
            throw new Error(`Environment '${name}' is not configured.`);
          }
          envsToTest = [name];
        } else {
          envsToTest = Object.keys(environments);
          if (envsToTest.length === 0) {
            output.log('No environments configured to test.');
            return;
          }
        }

        output.log('Testing environment connections (this may take a few seconds)...');

        const headers = ['Environment', 'Subsystem', 'Status', 'Details'];
        const rows: string[][] = [];

        for (const envName of envsToTest) {
          const config = environments[envName];
          const instanceUrl = config.instanceUrl || '';
          const apiKey = config.apiKey || '';
          const accessToken = config.accessToken || '';
          const mcpCommand = config.mcpCommand || 'npx -y n8n-mcp';
          const dbUrl = config.dbUrl || '';

          // 1. REST API
          const apiRes = await testRestApi(instanceUrl, apiKey);
          rows.push([
            envName,
            'REST API',
            apiRes.status,
            apiRes.message
          ]);

          // 2. MCP Client
          const mcpRes = await testMcp(mcpCommand, accessToken, instanceUrl);
          rows.push([
            envName,
            'MCP Server',
            mcpRes.status,
            mcpRes.message
          ]);

          // 3. PostgreSQL Database
          const dbRes = await testDatabase(dbUrl);
          rows.push([
            envName,
            'Database',
            dbRes.status,
            dbRes.message
          ]);
        }

        if (output.getJsonMode()) {
          console.log(JSON.stringify(rows.map(r => ({
            environment: r[0],
            subsystem: r[1],
            status: r[2],
            details: r[3]
          })), null, 2));
          return;
        }

        output.table(headers, rows);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  envs
    .command('edit <name>')
    .description('Create or edit configuration for a specific environment')
    .option('--url <url>', 'n8n instance URL (e.g. https://n8n.example.com)')
    .option('--mcp-command <cmd>', 'MCP command override (e.g. "npx -y n8n-mcp")')
    .option('--access-token <token>', 'MCP access token')
    .option('--api-key <key>', 'REST API key')
    .option('--db-url <url>', 'PostgreSQL database URL')
    .action(async (name, options) => {
      try {
        let url = options.url;
        let mcpCommand = options.mcpCommand;
        let accessToken = options.accessToken;
        let apiKey = options.apiKey;
        let dbUrl = options.dbUrl;

        // Interactive mode if no flags are passed
        const isInteractive = !url && !mcpCommand && !accessToken && !apiKey && !dbUrl;
        if (isInteractive) {
          const globalConfig = loadGlobalConfig();
          const existingEnv = globalConfig.environments?.[name] || {};

          output.log(`\nConfiguring environment '${name}' interactively...`);
          const prompter = createPrompter();
          try {
            url = await prompter.ask('Instance URL', existingEnv.instanceUrl || 'http://localhost:5678');
            mcpCommand = existingEnv.mcpCommand || 'npx -y n8n-mcp';
            accessToken = await prompter.ask('MCP Access Token', existingEnv.accessToken || '');
            apiKey = await prompter.ask('REST API Key (optional - press Enter to skip)', existingEnv.apiKey || '');
            dbUrl = await prompter.ask('PostgreSQL Database URL (optional - press Enter to skip)', existingEnv.dbUrl || '');
          } finally {
            prompter.close();
          }
        }

        const updates: any = {};
        if (url !== undefined) updates.instanceUrl = url;
        if (mcpCommand !== undefined) updates.mcpCommand = mcpCommand;
        if (accessToken !== undefined) updates.accessToken = accessToken;
        if (apiKey !== undefined) updates.apiKey = apiKey;
        if (dbUrl !== undefined) updates.dbUrl = dbUrl;

        saveGlobalConfig(updates, name);
        output.log(`\nSuccessfully updated environment '${name}' configuration in ~/.n8ncli-global.json`);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  envs
    .command('delete <name>')
    .alias('remove')
    .description('Remove configuration for a specific environment')
    .action(async (name) => {
      try {
        const globalConfig = loadGlobalConfig();
        const environments = globalConfig.environments || {};

        if (!environments[name]) {
          throw new Error(`Environment '${name}' is not configured.`);
        }

        delete environments[name];
        const p = getGlobalConfigPath();
        fs.writeFileSync(p, JSON.stringify(globalConfig, null, 2), 'utf-8');

        output.log(`Successfully deleted environment '${name}' from ~/.n8ncli-global.json`);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
