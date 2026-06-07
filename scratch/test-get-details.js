import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import dotenv from 'dotenv';

dotenv.config();

const url = new URL('https://n8n.parris.app/mcp-server/http');
const token = process.env.N8N_ACCESS_TOKEN;
const apiKey = process.env.N8N_API_KEY;
const workflowId = 'yY6V4ckA4Re4AKSz';

async function main() {
  // 1. Query via MCP
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { 'Authorization': `Bearer ${token}` } }
  });
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  console.log('Querying details via MCP...');
  const mcpRes = await client.callTool({
    name: 'get_workflow_details',
    arguments: { workflowId }
  });
  console.log('MCP Response:', mcpRes.content?.[0]?.text);
  await transport.close();

  // 2. Query via REST API
  console.log('\nQuerying details via REST API...');
  const restRes = await fetch(`https://n8n.parris.app/api/v1/workflows/${workflowId}`, {
    headers: { 'X-N8N-API-KEY': apiKey }
  });
  console.log('REST Response Status:', restRes.status);
  const restData = await restRes.json();
  console.log('REST Response keys:', Object.keys(restData));
  console.log('REST Response full body:', JSON.stringify(restData, null, 2));
}

main().catch(console.error);
