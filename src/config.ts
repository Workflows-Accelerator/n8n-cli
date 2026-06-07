import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import * as output from './output.js';

export interface N8nCliConfig {
  instanceUrl: string;
  environmentName: string;
  projectId: string;
  projectName: string;
  folderId?: string;
  folderName?: string;
  mcpServerCommand?: string; // e.g. "n8n mcp" or custom command
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
    dotenv.config({ path: envPath });
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
}

export function getConnectionInfo(options: { mcpCommand?: string; accessToken?: string } = {}): ConnectionInfo {
  const repoRoot = findRepoRoot();
  if (repoRoot) {
    loadEnv(repoRoot);
  } else {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
    }
  }

  let mcpCommand = options.mcpCommand || process.env.N8N_MCP_COMMAND;
  let accessToken = options.accessToken || process.env.N8N_ACCESS_TOKEN;
  let config: N8nCliConfig | null = null;

  if (repoRoot) {
    try {
      config = loadConfig(repoRoot);
      if (!mcpCommand) {
        mcpCommand = config.mcpServerCommand;
      }
    } catch (err) {
      // Ignore
    }
  }

  mcpCommand = mcpCommand || 'n8n mcp';
  
  if (!accessToken) {
    throw new Error(
      'n8n access token is required. Set N8N_ACCESS_TOKEN in your .env file, environment, or pass it via --access-token flag.'
    );
  }

  return {
    mcpCommand,
    accessToken,
    config,
    repoRoot,
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

export async function validateCookie(instanceUrl: string, cookie: string): Promise<boolean> {
  const endpoints = ['/rest/workflows', '/rest/active-workflows'];
  for (const ep of endpoints) {
    try {
      const res = await fetch(`${instanceUrl}${ep}`, {
        headers: {
          'Cookie': cookie,
          'Content-Type': 'application/json',
        },
      });
      if (res.status === 200) {
        return true;
      }
    } catch (err) {
      // ignore
    }
  }
  return false;
}

export async function fetchWorkflowsWithCookie(instanceUrl: string, cookie: string): Promise<any[] | null> {
  const endpoints = ['/rest/workflows', '/rest/active-workflows'];
  for (const ep of endpoints) {
    try {
      const res = await fetch(`${instanceUrl}${ep}`, {
        headers: {
          'Cookie': cookie,
          'Content-Type': 'application/json',
        },
      });
      if (res.status === 200) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data.data || []);
        if (list.length > 0) {
          return list;
        }
      }
    } catch (err) {
      // ignore
    }
  }
  return null;
}

export function saveCookieToEnv(repoRoot: string, cookieValue: string) {
  const envPath = path.join(repoRoot, '.env');
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf-8');
  }
  const lines = content.split(/\r?\n/);
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('N8N_COOKIE=')) {
      lines[i] = `N8N_COOKIE=${cookieValue}`;
      found = true;
      break;
    }
  }
  if (!found) {
    lines.push(`N8N_COOKIE=${cookieValue}`);
  }
  fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
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



