import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import dotenv from 'dotenv';

dotenv.config();

const url = new URL('https://n8n.parris.app/mcp-server/http');
const token = process.env.N8N_ACCESS_TOKEN;
const projectId = '5U5vIHIc1Ug5eVLK';
const workflowId = 'yY6V4ckA4Re4AKSz';

async function main() {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { 'Authorization': `Bearer ${token}` } }
  });
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  console.log('Searching workflows...');
  const res = await client.callTool({
    name: 'search_workflows',
    arguments: { projectId, limit: 100 }
  });
  
  const workflows = res.structuredContent?.data || [];
  const target = workflows.find(w => w.id === workflowId);
  
  console.log('Found workflow in list:', JSON.stringify(target, null, 2));

  await transport.close();
}

main().catch(console.error);
