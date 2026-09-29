import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { findRepoRoot, loadConfig, loadGlobalConfig, getConnectionInfo } from './config.js';
import * as output from './output.js';

export function splitCommandString(cmdStr: string): { command: string; args: string[] } {
  // Regex to split command string by space, while keeping quoted substrings together
  const matches = cmdStr.trim().match(/("[^"]+"|[^\s"]+)+/g);
  if (!matches) {
    return { command: cmdStr, args: [] };
  }
  const parts = matches.map(arg => {
    if (arg.startsWith('"') && arg.endsWith('"')) {
      return arg.slice(1, -1);
    }
    return arg;
  });
  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

export class McpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | StreamableHTTPClientTransport | null = null;

  async connect(commandStr: string, accessToken: string, instanceUrlOverride?: string) {
    let instanceUrl: string | undefined = instanceUrlOverride;

    if (!instanceUrl) {
      if (commandStr.startsWith('http://') || commandStr.startsWith('https://')) {
        instanceUrl = commandStr;
      } else {
        try {
          const repoRoot = findRepoRoot();
          const globalConfig = loadGlobalConfig();
          
          let envKey = 'development';
          if (repoRoot) {
            try {
              const config = loadConfig(repoRoot);
              envKey = config.env || config.environmentName || 'development';
            } catch (e) {
              // Ignore
            }
          } else {
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
          
          instanceUrl = globalConfig.environments?.[envKey]?.instanceUrl || globalConfig.instanceUrl;
        } catch (err) {
          // Ignore
        }
      }
    }

    if (instanceUrl) {
      const sseUrl = instanceUrl.endsWith('/mcp-server/http')
        ? new URL(instanceUrl)
        : new URL('/mcp-server/http', instanceUrl);

      this.transport = new StreamableHTTPClientTransport(sseUrl, {
        requestInit: {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        }
      });
    } else {
      const { command, args } = splitCommandString(commandStr);

      const env = {
        ...process.env,
        N8N_ACCESS_TOKEN: accessToken,
      } as Record<string, string>;

      this.transport = new StdioClientTransport({
        command,
        args,
        env,
        stderr: 'inherit', // output server stderr directly to CLI stderr for debugging
      });
    }

    this.client = new Client(
      { name: 'n8n-cli-sync', version: '1.0.0' },
      { capabilities: {} }
    );

    await this.client.connect(this.transport);
  }

  async callTool(name: string, args: Record<string, any> = {}): Promise<any> {
    if (!this.client) {
      throw new Error('MCP Client is not connected.');
    }
    
    const sanitizedArgs = { ...args };
    if (typeof sanitizedArgs.limit === 'number' && sanitizedArgs.limit > 200) {
      sanitizedArgs.limit = 200;
    }

    const result = await this.client.callTool({
      name,
      arguments: sanitizedArgs,
    });

    if (result.isError) {
      const content = result.content as any;
      const text = content
        ?.filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
      throw new Error(text || `Tool execution '${name}' failed with an unknown error.`);
    }

    return result;
  }

  /**
   * Helper to call tool and return the text content.
   */
  async callToolAndGetText(name: string, args: Record<string, any> = {}): Promise<string> {
    const result = await this.callTool(name, args);
    const textContent = result.content?.find((c: any) => c.type === 'text')?.text;
    if (textContent === undefined) {
      throw new Error(`Tool execution '${name}' did not return any text content.`);
    }
    return textContent;
  }

  /**
   * Helper to call tool and parse its text response as JSON.
   */
  async callToolAndGetJson<T = any>(name: string, args: Record<string, any> = {}): Promise<T> {
    const text = await this.callToolAndGetText(name, args);
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new Error(`Failed to parse JSON response from tool '${name}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async disconnect() {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch (err) {
        // ignore disconnect failures
      }
    }
    this.client = null;
    this.transport = null;
  }
}

export async function withMcp<T>(
  commandStr: string,
  accessToken: string,
  fn: (client: McpClient) => Promise<T>,
  instanceUrlOverride?: string
): Promise<T> {
  const client = new McpClient();
  await client.connect(commandStr, accessToken, instanceUrlOverride);
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}

export function parseLatestVersions(text: string): Record<string, number> {
  const versions: Record<string, number> = {};
  const lines = text.split('\n');
  let currentId: string | null = null;

  for (const line of lines) {
    const nodeMatch = line.match(/^-\s+([a-zA-Z0-9.-]+)(?:\s+\[TRIGGER\])?\s*$/i);
    if (nodeMatch) {
      currentId = nodeMatch[1];
      continue;
    }
    if (currentId) {
      const versionMatch = line.match(/^\s*Version:\s*([0-9.]+)\s*$/i);
      if (versionMatch) {
        versions[currentId] = parseFloat(versionMatch[1]);
        currentId = null;
      } else if (line.startsWith('- ')) {
        currentId = null;
      }
    }
  }
  return versions;
}

export async function fetchLatestNodeVersions(
  uniqueNodeTypes: Set<string>,
  options: any
): Promise<Record<string, number>> {
  let latestVersions: Record<string, number> = {};
  if (uniqueNodeTypes.size === 0) return latestVersions;

  try {
    const { mcpCommand, accessToken } = getConnectionInfo(options);
    await withMcp(mcpCommand, accessToken, async (mcp) => {
      const queries = Array.from(uniqueNodeTypes);
      let text = '';
      const retries = 3;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          text = await mcp.callToolAndGetText('search_nodes', { queries });
          break;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const isRateLimit = errMsg.includes('Too many requests') || errMsg.includes('429');
          if (isRateLimit && attempt < retries) {
            output.warn(`Rate limit on MCP search_nodes. Retrying in 2 seconds...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
          }
          throw err;
        }
      }
      latestVersions = parseLatestVersions(text);
    });
  } catch (err) {
    output.warn(`Warning: Could not connect to n8n MCP to fetch latest node versions. Skipping version validation. (${err instanceof Error ? err.message : String(err)})`);
  }
  return latestVersions;
}

