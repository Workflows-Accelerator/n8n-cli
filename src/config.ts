import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import os from 'os';
import pg from 'pg';
import { generateWorkflowCode } from '@n8n/workflow-sdk';
import * as output from './output.js';

export interface ReferenceSource {
  name?: string;
  env?: string;
  projectId?: string;
  projectName?: string;
  folderId?: string;
  folderName?: string;
  path?: string;
  repository?: string;
  branch?: string;
}

export interface N8nCliConfig {
  env?: string;
  environmentName?: string;
  projectId: string;
  projectName: string;
  folderId?: string;
  folderName?: string;
  localDir?: string;
  references?: ReferenceSource | ReferenceSource[];
}

export function getConfigPath(repoRoot: string): string {
  let requestedEnv = '';
  const envArgIndex = process.argv.indexOf('--env');
  if (envArgIndex !== -1 && envArgIndex + 1 < process.argv.length) {
    requestedEnv = process.argv[envArgIndex + 1];
  } else {
    const envArg = process.argv.find(arg => arg.startsWith('--env='));
    if (envArg) {
      requestedEnv = envArg.split('=')[1];
    }
  }

  // 1. If an environment is requested, find the config file that matches it
  if (requestedEnv) {
    // Check root
    const rootPath = path.join(repoRoot, 'n8n-cli.json');
    if (fs.existsSync(rootPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(rootPath, 'utf-8'));
        if (parsed.env === requestedEnv || parsed.environmentName === requestedEnv) {
          return rootPath;
        }
      } catch (e) {}
    }

    // Check default n8n
    const defaultPath = path.join(repoRoot, 'n8n', 'config', 'n8n-cli.json');
    if (fs.existsSync(defaultPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(defaultPath, 'utf-8'));
        if (parsed.env === requestedEnv || parsed.environmentName === requestedEnv) {
          return defaultPath;
        }
      } catch (e) {}
    }

    // Check custom subdirectories
    try {
      const entries = fs.readdirSync(repoRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'dist' && entry.name !== 'build') {
          const p = path.join(repoRoot, entry.name, 'config', 'n8n-cli.json');
          if (fs.existsSync(p)) {
            try {
              const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
              if (parsed.env === requestedEnv || parsed.environmentName === requestedEnv) {
                return p;
              }
            } catch (e) {}
          }
        }
      }
    } catch (e) {}
  }

  // 2. Fallback to normal lookup if no match was found or no environment requested
  const rootPath = path.join(repoRoot, 'n8n-cli.json');
  if (fs.existsSync(rootPath)) {
    return rootPath;
  }
  
  const defaultPath = path.join(repoRoot, 'n8n', 'config', 'n8n-cli.json');
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }
  
  try {
    const entries = fs.readdirSync(repoRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'dist' && entry.name !== 'build') {
        const possibleConfig = path.join(repoRoot, entry.name, 'config', 'n8n-cli.json');
        if (fs.existsSync(possibleConfig)) {
          return possibleConfig;
        }
      }
    }
  } catch (e) {}

  return defaultPath;
}

export function findRepoRoot(startDir: string = process.cwd()): string | null {
  let currentDir = path.resolve(startDir);
  while (true) {
    // 1. Check if there is an n8n-cli.json in the currentDir root
    if (fs.existsSync(path.join(currentDir, 'n8n-cli.json'))) {
      return currentDir;
    }

    // 2. Check n8n/config/n8n-cli.json
    if (fs.existsSync(path.join(currentDir, 'n8n', 'config', 'n8n-cli.json'))) {
      return currentDir;
    }

    // 3. Scan subdirectories of currentDir for <dir>/config/n8n-cli.json
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'dist' && entry.name !== 'build') {
          const possibleConfig = path.join(currentDir, entry.name, 'config', 'n8n-cli.json');
          if (fs.existsSync(possibleConfig)) {
            return currentDir;
          }
        }
      }
    } catch (e) {}

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
  const configPath = getConfigPath(repoRoot);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found. Run 'n8ncli init' first.`);
  }
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content) as N8nCliConfig;
    if (!parsed.localDir) {
      const relative = path.relative(repoRoot, configPath);
      const segments = relative.split(path.sep);
      if (segments.length > 1 && segments[0] !== 'n8n-cli.json') {
        parsed.localDir = segments[0];
      } else {
        parsed.localDir = 'n8n';
      }
    }
    return parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read/parse configuration at ${configPath}: ${message}`);
  }
}

export function saveConfig(repoRoot: string, config: N8nCliConfig) {
  const localDir = config.localDir || 'n8n';
  const configDir = path.join(repoRoot, localDir, 'config');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  const configPath = path.join(configDir, 'n8n-cli.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

export function getLayoutSettingsPath(repoRoot: string): string {
  const configPath = getConfigPath(repoRoot);
  const configDir = path.dirname(configPath);
  return path.join(configDir, 'n8n-layout.json');
}

export interface LayoutSettings {
  grid: number;
  nodesep: number;
  ranksep: number;
  alignment: string;
  alignTerminalNodes: boolean;
  subnodeSep?: number;
  subnodeHorizontalSep?: number;
}

export function loadLayoutSettings(repoRoot: string): LayoutSettings {
  const layoutPath = getLayoutSettingsPath(repoRoot);
  let layoutJson: any = {};
  if (fs.existsSync(layoutPath)) {
    try {
      const content = fs.readFileSync(layoutPath, 'utf-8');
      layoutJson = JSON.parse(content);
    } catch (e) {
      // ignore
    }
  }

  // Load main config for fallback
  let cliLayoutConfig: any = {};
  try {
    const cliConfig = loadConfig(repoRoot);
    cliLayoutConfig = (cliConfig as any).layout || {};
  } catch (e) {
    // ignore
  }

  // Merge: n8n-layout.json values take precedence over n8n-cli.json layout block
  const grid = layoutJson.grid !== undefined ? layoutJson.grid : (cliLayoutConfig.grid !== undefined ? cliLayoutConfig.grid : 20);
  const nodesep = layoutJson.nodesep !== undefined ? layoutJson.nodesep : (cliLayoutConfig.nodesep !== undefined ? cliLayoutConfig.nodesep : (2 * grid));
  const ranksep = layoutJson.ranksep !== undefined ? layoutJson.ranksep : (cliLayoutConfig.ranksep !== undefined ? cliLayoutConfig.ranksep : (6 * grid));
  const alignment = layoutJson.alignment !== undefined ? layoutJson.alignment : (cliLayoutConfig.alignment !== undefined ? cliLayoutConfig.alignment : 'center');
  const alignTerminalNodes = layoutJson.alignTerminalNodes !== undefined ? layoutJson.alignTerminalNodes : (cliLayoutConfig.alignTerminalNodes !== undefined ? cliLayoutConfig.alignTerminalNodes : true);
  
  const settings: LayoutSettings = {
    grid,
    nodesep,
    ranksep,
    alignment,
    alignTerminalNodes,
  };

  if (layoutJson.subnodeSep !== undefined) {
    settings.subnodeSep = layoutJson.subnodeSep;
  } else if (cliLayoutConfig.subnodeSep !== undefined) {
    settings.subnodeSep = cliLayoutConfig.subnodeSep;
  }

  if (layoutJson.subnodeHorizontalSep !== undefined) {
    settings.subnodeHorizontalSep = layoutJson.subnodeHorizontalSep;
  } else if (cliLayoutConfig.subnodeHorizontalSep !== undefined) {
    settings.subnodeHorizontalSep = cliLayoutConfig.subnodeHorizontalSep;
  }

  return settings;
}

export function saveDefaultLayoutSettings(repoRoot: string) {
  const layoutPath = getLayoutSettingsPath(repoRoot);
  const dir = path.dirname(layoutPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const defaultLayout = {
    grid: 20,
    nodesep: 80,
    ranksep: 120,
    alignment: 'center',
    alignTerminalNodes: true,
    subnodeSep: 160,
    subnodeHorizontalSep: 80
  };
  fs.writeFileSync(layoutPath, JSON.stringify(defaultLayout, null, 2), 'utf-8');
}


export interface ConnectionInfo {
  mcpCommand: string;
  accessToken: string;
  config: N8nCliConfig | null;
  repoRoot: string | null;
  apiKey: string;
  instanceUrl: string;
  localDir: string;
  dbUrl: string;
}

export function getConnectionInfo(options: { mcpCommand?: string; accessToken?: string; apiKey?: string; url?: string; env?: string; dbUrl?: string; config?: string } = {}): ConnectionInfo {
  let repoRoot = findRepoRoot();
  let configPath = '';

  if (options.config) {
    configPath = path.resolve(options.config);
    if (fs.existsSync(configPath)) {
      if (configPath.endsWith(path.join('config', 'n8n-cli.json'))) {
        repoRoot = path.dirname(path.dirname(configPath));
      } else {
        repoRoot = path.dirname(configPath);
      }
    } else {
      throw new Error(`Custom configuration file not found at ${configPath}`);
    }
  }

  if (repoRoot) {
    loadEnv(repoRoot);
  } else {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
    }
  }

  let config: N8nCliConfig | null = null;
  if (options.config) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      config = JSON.parse(content) as N8nCliConfig;
      if (!config.localDir) {
        const relative = path.relative(repoRoot || process.cwd(), configPath);
        const segments = relative.split(path.sep);
        if (segments.length > 1 && segments[0] !== 'n8n-cli.json') {
          config.localDir = segments[0];
        } else {
          config.localDir = 'n8n';
        }
      }
    } catch (err) {
      throw new Error(`Failed to read/parse custom configuration at ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (repoRoot) {
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

  let mcpCommand = options.mcpCommand || process.env.N8N_MCP_COMMAND || envConfig.mcpCommand || globalConfig.mcpCommand || 'npx -y n8n-mcp';
  let accessToken = options.accessToken || process.env.N8N_ACCESS_TOKEN || envConfig.accessToken || globalConfig.accessToken;
  let apiKey = options.apiKey || process.env.N8N_API_KEY || envConfig.apiKey || globalConfig.apiKey || '';
  let instanceUrl = options.url || process.env.N8N_INSTANCE_URL || envConfig.instanceUrl || globalConfig.instanceUrl || '';
  let dbUrl = options.dbUrl || process.env.N8N_DB_URL || envConfig.dbUrl || globalConfig.dbUrl || '';

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

  const localDir = config?.localDir || 'n8n';

  return {
    mcpCommand,
    accessToken,
    config,
    repoRoot,
    apiKey,
    instanceUrl,
    localDir,
    dbUrl,
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

export function loadFolderCache(repoRoot: string, localDir: string = 'n8n'): Record<string, string | null> {
  const cachePath = path.join(repoRoot, localDir, 'config', 'workflow-folders.json');
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    } catch (e) {
      // ignore
    }
  }
  return {};
}

export function saveFolderCache(repoRoot: string, cache: Record<string, string | null>, localDir: string = 'n8n') {
  const cacheDir = path.join(repoRoot, localDir, 'config');
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

export async function fetchWorkflowsPaginated(
  instanceUrl: string,
  projectId: string,
  headers: Record<string, string>,
  retries = 3
): Promise<any[]> {
  let workflows: any[] = [];
  let cursor = '';
  while (true) {
    const cleanUrl = instanceUrl.replace(/\/$/, '');
    const url = `${cleanUrl}/api/v1/workflows?projectId=${projectId}&limit=250${cursor ? `&cursor=${cursor}` : ''}`;
    let data: any = null;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, { headers });
        if (res.ok) {
          data = await res.json();
          break;
        }
        if (res.status === 429 && attempt < retries) {
          output.warn(`Rate limit listing workflows. Retrying in 2 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        if (attempt === retries) {
          throw new Error(`REST API listing failed with status ${res.status}: ${res.statusText}`);
        }
      } catch (err) {
        if (attempt === retries) throw err;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    const pageWorkflows = Array.isArray(data) ? data : (data.data || data.workflows || []);
    workflows = workflows.concat(pageWorkflows);
    
    const nextCursor = data?.nextCursor;
    if (!nextCursor || pageWorkflows.length === 0) {
      break;
    }
    cursor = nextCursor;
  }
  return workflows;
}

export async function fetchWorkflowsWithDb(dbUrl: string): Promise<any[] | null> {
  const pgClient = pg as any;
  const ClientClass = pgClient.Client || pgClient.default?.Client || pgClient;
  const client = new ClientClass({
    connectionString: dbUrl,
    ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false')) ? false : { rejectUnauthorized: false }
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

export function convertLocalJsonWorkflows(workflowsDir: string) {
  if (!fs.existsSync(workflowsDir)) return;
  
  const getJsonFiles = (dir: string): string[] => {
    let results: string[] = [];
    try {
      const list = fs.readdirSync(dir, { withFileTypes: true });
      for (const file of list) {
        const filePath = path.join(dir, file.name);
        if (file.isDirectory()) {
          results = results.concat(getJsonFiles(filePath));
        } else if (file.isFile() && file.name.endsWith('.json') && file.name !== 'sync-state.json' && file.name !== 'workflow-folders.json') {
          results.push(filePath);
        }
      }
    } catch (e) {
      // ignore
    }
    return results;
  };

  const jsonFiles = getJsonFiles(workflowsDir);
  for (const jsonPath of jsonFiles) {
    try {
      const content = fs.readFileSync(jsonPath, 'utf-8');
      const parsed = JSON.parse(content);
      
      // Basic heuristic to check if this is indeed a workflow JSON
      if (parsed && (Array.isArray(parsed.nodes) || parsed.connections)) {
        output.log(`Converting JSON workflow '${parsed.name || path.basename(jsonPath)}' to TypeScript SDK...`);
        const tsCode = generateWorkflowCode(parsed);
        const tsPath = jsonPath.replace(/\.json$/, '.workflow.ts');
        fs.writeFileSync(tsPath, tsCode, 'utf-8');
        fs.unlinkSync(jsonPath);
        output.log(`  [CONVERTED] Created ${path.relative(workflowsDir, tsPath)} and deleted original JSON.`);
      }
    } catch (e) {
      // Not a valid workflow JSON, skip it silently
    }
  }
}

export function resolveAndConvertTarget(target: string, workflowsDir: string): string {
  let targetPath = target;
  let fullPath = path.resolve(targetPath);
  
  if (!fs.existsSync(fullPath)) {
    const altPath = path.join(workflowsDir, targetPath);
    if (fs.existsSync(altPath)) {
      fullPath = altPath;
      targetPath = altPath;
    }
  }

  if (targetPath.endsWith('.json')) {
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const parsed = JSON.parse(content);
        if (parsed && (Array.isArray(parsed.nodes) || parsed.connections)) {
          const tsCode = generateWorkflowCode(parsed);
          const tsPath = fullPath.replace(/\.json$/, '.workflow.ts');
          fs.writeFileSync(tsPath, tsCode, 'utf-8');
          fs.unlinkSync(fullPath);
          output.log(`Converted targeted JSON workflow to TypeScript SDK: ${path.basename(tsPath)}`);
          targetPath = tsPath;
        }
      } catch (e) {
        // ignore
      }
    }
  }
  return targetPath;
}

export interface UnconfiguredCredential {
  id: string;
  name: string;
  type: string;
  url: string;
}

export function generateRandomCredId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

export async function syncCredentials(
  repoRoot: string,
  config: N8nCliConfig,
  dbUrl: string,
  localDir: string = 'n8n'
): Promise<UnconfiguredCredential[]> {
  const unconfigured: UnconfiguredCredential[] = [];
  if (!dbUrl || !config.projectId) {
    return unconfigured;
  }

  const workflowsDir = path.join(repoRoot, localDir, 'workflows');
  if (!fs.existsSync(workflowsDir)) {
    return unconfigured;
  }

  const getWorkflowFiles = (dir: string): string[] => {
    let results: string[] = [];
    try {
      const list = fs.readdirSync(dir, { withFileTypes: true });
      for (const file of list) {
        const filePath = path.join(dir, file.name);
        if (file.isDirectory()) {
          results = results.concat(getWorkflowFiles(filePath));
        } else if (file.isFile() && file.name.endsWith('.workflow.ts')) {
          results.push(filePath);
        }
      }
    } catch (e) {}
    return results;
  };

  const files = getWorkflowFiles(workflowsDir);
  const credsToSync = new Map<string, { type: string; name: string; id: string }>();

  const regex = /(\w+)\s*:\s*newCredential\(\s*(['"`])(.*?)\2(?:\s*,\s*(['"`])(.*?)\4)?\s*\)/g;

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      let match;
      while ((match = regex.exec(content)) !== null) {
        const type = match[1];
        const name = match[3];
        const id = match[5] || '';
        const key = `${type}:${name}:${id}`;
        credsToSync.set(key, { type, name, id });
      }
    } catch (e) {}
  }

  if (credsToSync.size === 0) {
    saveUnconfiguredCredsCache(repoRoot, [], localDir);
    return unconfigured;
  }

  const pgClient = pg as any;
  const ClientClass = pgClient.Client || pgClient.default?.Client || pgClient;
  const client = new ClientClass({
    connectionString: dbUrl,
    ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false')) ? false : { rejectUnauthorized: false }
  });

  try {
    await client.connect();

    const instanceUrl = process.env.N8N_INSTANCE_URL || loadGlobalConfig().environments?.[config.env || 'development']?.instanceUrl || loadGlobalConfig().instanceUrl || 'http://localhost:5678';
    const cleanInstanceUrl = instanceUrl.replace(/\/$/, '');

    for (const [_, cred] of credsToSync) {
      let res;
      if (cred.id) {
        res = await client.query(
          `SELECT id, name, type, data FROM credentials_entity WHERE id = $1;`,
          [cred.id]
        );
      } else {
        res = await client.query(
          `SELECT c.id, c.name, c.type, c.data
           FROM credentials_entity c
           INNER JOIN shared_credentials s ON s."credentialsId" = c.id
           WHERE c.type = $1 AND c.name = $2 AND s."projectId" = $3;`,
          [cred.type, cred.name, config.projectId]
        );
      }

      let credId = '';
      let isUnconfigured = false;

      if (res.rows.length > 0) {
        const row = res.rows[0];
        credId = row.id;

        // Ensure shared record exists
        const shareRes = await client.query(
          `SELECT * FROM shared_credentials WHERE "credentialsId" = $1 AND "projectId" = $2;`,
          [credId, config.projectId]
        );
        if (shareRes.rows.length === 0) {
          await client.query(
            `INSERT INTO shared_credentials ("credentialsId", "projectId", "role", "createdAt", "updatedAt")
             VALUES ($1, $2, 'credential:owner', NOW(), NOW());`,
            [credId, config.projectId]
          );
        }

        if (!row.data || row.data.trim() === '' || row.data === '{}') {
          isUnconfigured = true;
        }
      } else {
        credId = cred.id || generateRandomCredId();
        
        await client.query(
          `INSERT INTO credentials_entity (id, name, type, data, "createdAt", "updatedAt", "isManaged", "isGlobal", "isResolvable", "resolvableAllowFallback")
           VALUES ($1, $2, $3, $4, NOW(), NOW(), false, false, false, false);`,
          [credId, cred.name, cred.type, '']
        );

        await client.query(
          `INSERT INTO shared_credentials ("credentialsId", "projectId", "role", "createdAt", "updatedAt")
           VALUES ($1, $2, 'credential:owner', NOW(), NOW());`,
          [credId, config.projectId]
        );

        output.log(`Created credential placeholder in DB: '${cred.name}' (type: ${cred.type}, ID: ${credId})`);
        isUnconfigured = true;
      }

      if (isUnconfigured) {
        const url = `${cleanInstanceUrl}/projects/${config.projectId}/credentials/${credId}?uiContext=credentials_list`;
        unconfigured.push({
          id: credId,
          name: cred.name,
          type: cred.type,
          url
        });
      }
    }
  } catch (err) {
    output.warn(`Failed to sync credentials with database: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      await client.end();
    } catch (e) {}
  }

  saveUnconfiguredCredsCache(repoRoot, unconfigured, localDir);
  return unconfigured;
}

export function saveUnconfiguredCredsCache(repoRoot: string, cache: UnconfiguredCredential[], localDir: string = 'n8n') {
  const cacheDir = path.join(repoRoot, localDir, 'config');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  const cachePath = path.join(cacheDir, 'unconfigured-credentials.json');
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
}

export function loadUnconfiguredCredsCache(repoRoot: string, localDir: string = 'n8n'): UnconfiguredCredential[] {
  const cachePath = path.join(repoRoot, localDir, 'config', 'unconfigured-credentials.json');
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    } catch (e) {}
  }
  return [];
}




