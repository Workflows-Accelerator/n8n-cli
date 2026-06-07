import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { findRepoRoot, loadConfig, loadGlobalConfig } from './config.js';

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

  async connect(commandStr: string, accessToken: string) {
    let instanceUrl: string | undefined;

    if (commandStr.startsWith('http://') || commandStr.startsWith('https://')) {
      instanceUrl = commandStr;
    } else {
      try {
        const globalConfig = loadGlobalConfig();
        instanceUrl = globalConfig.instanceUrl;
      } catch (err) {
        // Ignore
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
    
    const result = await this.client.callTool({
      name,
      arguments: args,
    });

    if (result.isError) {
      const text = result.content
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
  fn: (client: McpClient) => Promise<T>
): Promise<T> {
  const client = new McpClient();
  await client.connect(commandStr, accessToken);
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}
