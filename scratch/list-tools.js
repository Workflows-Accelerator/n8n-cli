import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

function loadGlobalConfig() {
  const p = path.join(os.homedir(), '.n8ncli-global.json');
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }
  return {};
}

async function main() {
  const globalConfig = loadGlobalConfig();
  const parris = globalConfig.environments?.PARRIS || {};
  const url = new URL(parris.instanceUrl + '/mcp-server/http');
  const token = parris.accessToken;

  console.log('Connecting to MCP server at:', url.toString());
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { 'Authorization': `Bearer ${token}` } }
  });
  const client = new Client({ name: 'list-tools-script', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  console.log('Listing tools...');
  const response = await client.listTools();
  console.log('Tools count:', response.tools?.length);
  for (const tool of response.tools || []) {
    console.log(`- ${tool.name}: ${tool.description}`);
  }

  await transport.close();
}

main().catch(console.error);
