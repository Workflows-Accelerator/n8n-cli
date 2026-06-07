import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

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

