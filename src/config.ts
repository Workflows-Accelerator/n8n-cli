import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import os from 'os';
import pg from 'pg';
import * as output from './output.js';

export interface N8nCliConfig {
  env?: string;
  environmentName?: string;
  projectId: string;
  projectName: string;
  folderId?: string;
  folderName?: string;
  references?: {
    projectId: string;
    projectName: string;
    folderId?: string;
    folderName?: string;
  };
}

export function findRepoRoot(startDir: string = process.cwd()): string | null {
  let currentDir = path.resolve(startDir);
  while (true) {
    const configPath = path.join(currentDir, 'n8n', 'config', 'n8n-cli.json');
    if (fs.existsSync(configPath)) {
      return currentDir;
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    currentDir = parent;
  }
  return null;
}

export function loadEnv(repoRoot: string) {
  const envPath = path.join(repoRoot, '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: true });
  }
}

export function loadConfig(repoRoot: string): N8nCliConfig {
  const configPath = path.join(repoRoot, 'n8n', 'config', 'n8n-cli.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found at ${configPath}. Run 'n8ncli init' first.`);
  }
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as N8nCliConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read/parse configuration at ${configPath}: ${message}`);
  }
}

export function saveConfig(repoRoot: string, config: N8nCliConfig) {
  const configDir = path.join(repoRoot, 'n8n', 'config');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  const configPath = path.join(configDir, 'n8n-cli.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

export interface ConnectionInfo {
  mcpCommand: string;
  accessToken: string;
  config: N8nCliConfig | null;
  repoRoot: string | null;
  apiKey: string;
  instanceUrl: string;
}

export function getConnectionInfo(options: { mcpCommand?: string; accessToken?: string; apiKey?: string; url?: string; env?: string } = {}): ConnectionInfo {
  const repoRoot = findRepoRoot();
  if (repoRoot) {
    loadEnv(repoRoot);
  } else {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
    }
  }

  let config: N8nCliConfig | null = null;
  if (repoRoot) {
    try {
      config = loadConfig(repoRoot);
    } catch (err) {
      // Ignore
    }
  }

  const globalConfig = loadGlobalConfig();
  let envKey = options.env;
  if (!envKey) {
    const envArgIndex = process.argv.indexOf('--env');
    if (envArgIndex !== -1 && envArgIndex + 1 < process.argv.length) {
      envKey = process.argv[envArgIndex + 1];
    } else {
      const envArg = process.argv.find(arg => arg.startsWith('--env='));
      if (envArg) {
        envKey = envArg.split('=')[1];
      }
    }
  }
  if (!envKey) {
    envKey = config?.env || config?.environmentName || 'development';
  }
  const envConfig = globalConfig.environments?.[envKey] || {};

  let mcpCommand = options.mcpCommand || process.env.N8N_MCP_COMMAND || envConfig.mcpCommand || globalConfig.mcpCommand || 'n8n mcp';
  let accessToken = options.accessToken || process.env.N8N_ACCESS_TOKEN || envConfig.accessToken || globalConfig.accessToken;
  let apiKey = options.apiKey || process.env.N8N_API_KEY || envConfig.apiKey || globalConfig.apiKey || '';
  let instanceUrl = options.url || process.env.N8N_INSTANCE_URL || envConfig.instanceUrl || globalConfig.instanceUrl || '';

  if (!accessToken) {
    throw new Error(
      `n8n access token is required. Set N8N_ACCESS_TOKEN in your environment, global config environments.${envKey}.accessToken, or pass it via --access-token flag.`
    );
  }

  if (!instanceUrl) {
    throw new Error(
      `n8n instance URL is required. Set N8N_INSTANCE_URL in your environment, global config environments.${envKey}.instanceUrl, or pass it via --url flag.`
    );
  }

  return {
    mcpCommand,
    accessToken,
    config,
    repoRoot,
    apiKey,
    instanceUrl,
  };
}

export function buildFolderPaths(folders: any[], targetFolderId?: string): Record<string, string> {
  const paths: Record<string, string> = {};
  const folderMap = new Map<string, any>(folders.map(f => [f.id, f]));

  const getPath = (id: string): string[] => {
    if (id === targetFolderId) {
      return [];
    }
    const folder = folderMap.get(id);
    if (!folder) {
      return [];
    }
    const parentId = folder.parentFolderId;
    if (!parentId || parentId === id) {
      return [folder.name];
    }
    return [...getPath(parentId), folder.name];
  };

  for (const f of folders) {
    if (targetFolderId) {
      let current = f;
      let isDescendant = false;
      while (current) {
        if (current.parentFolderId === targetFolderId) {
          isDescendant = true;
          break;
        }
        current = current.parentFolderId ? folderMap.get(current.parentFolderId) : null;
      }
      if (!isDescendant && f.id !== targetFolderId) {
        continue;
      }
    }

    const segments = getPath(f.id);
    if (segments.length > 0) {
      const sanitized = segments.map(seg => seg.replace(/[\\/:*?"<>|]/g, '_'));
      paths[f.id] = sanitized.join('/');
    }
  }
  return paths;
}

export function loadFolderCache(repoRoot: string): Record<string, string | null> {
  const cachePath = path.join(repoRoot, 'n8n', 'config', 'workflow-folders.json');
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    } catch (e) {
      // ignore
    }
  }
  return {};
}

export function saveFolderCache(repoRoot: string, cache: Record<string, string | null>) {
  const cacheDir = path.join(repoRoot, 'n8n', 'config');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  const cachePath = path.join(cacheDir, 'workflow-folders.json');
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
}

export async function getWorkflowDetails(
  mcp: any,
  instanceUrl: string,
  apiKey: string,
  workflowId: string,
  retries = 2
): Promise<any> {
  if (apiKey && instanceUrl) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetch(`${instanceUrl}/api/v1/workflows/${workflowId}`, {
          headers: {
            'X-N8N-API-KEY': apiKey,
            'Content-Type': 'application/json',
          },
        });
        if (res.ok) {
          return await res.json();
        }
        if (res.status === 429 && attempt < retries) {
          output.warn(`Rate limit on REST API details for ${workflowId}. Retrying in 2 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
      } catch (err) {
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
      }
    }
  }

  // Fallback to MCP
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      const detailsRes = await mcp.callToolAndGetJson('get_workflow_details', {
        workflowId,
        id: workflowId,
      });
      return detailsRes.workflow || detailsRes;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if ((errMsg.includes('Too many requests') || errMsg.includes('429')) && attempt < retries) {
        output.warn(`Rate limit on MCP details for ${workflowId}. Retrying in 2 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      throw err;
    }
  }
}

export interface GlobalEnvConfig {
  instanceUrl?: string;
  mcpCommand?: string;
  dbUrl?: string;
  accessToken?: string;
  apiKey?: string;
}

export interface GlobalConfig {
  environments?: Record<string, GlobalEnvConfig>;
  // Fallbacks for backward compatibility
  dbUrl?: string;
  accessToken?: string;
  apiKey?: string;
  instanceUrl?: string;
  mcpCommand?: string;
}

export function getGlobalConfigPath(): string {
  return path.join(os.homedir(), '.n8ncli-global.json');
}

export function loadGlobalConfig(): GlobalConfig {
  const p = getGlobalConfigPath();
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) {
      // ignore
    }
  }
  return {};
}

export function saveGlobalConfig(config: Partial<GlobalEnvConfig> & Partial<GlobalConfig>, envName?: string) {
  const p = getGlobalConfigPath();
  const existing = loadGlobalConfig();
  
  if (envName) {
    if (!existing.environments) {
      existing.environments = {};
    }
    existing.environments[envName] = {
      ...existing.environments[envName],
      ...(config as any)
    };
  } else {
    Object.assign(existing, config);
  }
  
  fs.writeFileSync(p, JSON.stringify(existing, null, 2), 'utf-8');
}

export async function fetchWorkflowsWithDb(dbUrl: string): Promise<any[] | null> {
  const pgClient = pg as any;
  const ClientClass = pgClient.Client || pgClient.default?.Client || pgClient;
  const client = new ClientClass({
    connectionString: dbUrl,
    ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    
    // Find schemas and columns dynamically
    const colsRes = await client.query(`
      SELECT column_name, table_schema
      FROM information_schema.columns 
      WHERE table_name = 'workflow_entity';
    `);
    
    if (colsRes.rows.length === 0) {
      throw new Error('workflow_entity table not found in database.');
    }
    
    const schema = colsRes.rows[0].table_schema;
    const cols = colsRes.rows.map((r: any) => r.column_name);
    
    let folderCol = '';
    if (cols.includes('parentFolderId')) {
      folderCol = 'parentFolderId';
    } else if (cols.includes('folderId')) {
      folderCol = 'folderId';
    } else {
      const found = cols.find((c: string) => c.toLowerCase().includes('folder'));
      if (found) {
        folderCol = found;
      }
    }
    
    if (!folderCol) {
      throw new Error('Could not find folder relation column in workflow_entity table.');
    }
    
    const queryStr = `SELECT id, "${folderCol}" AS "parentFolderId" FROM "${schema}"."workflow_entity";`;
    const res = await client.query(queryStr);
    return res.rows;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to query n8n database: ${errMsg}`);
  } finally {
    try {
      await client.end();
    } catch (e) {
      // ignore
    }
  }
}



