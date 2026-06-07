import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import dotenv from 'dotenv';

dotenv.config();

const url = new URL('https://n8n.parris.app/mcp-server/http');
const token = process.env.N8N_ACCESS_TOKEN;
const projectId = '5U5vIHIc1Ug5eVLK';

async function main() {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { 'Authorization': `Bearer ${token}` } }
  });
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  console.log(`Calling search_folders for project ${projectId}...`);
  try {
    const res = await client.callTool({
      name: 'search_folders',
      arguments: { projectId }
    });
    console.log('Response:', JSON.stringify(res, null, 2));
  } catch (err) {
    console.error('Tool error:', err.message);
  }

  await transport.close();
}

main().catch(console.error);
