import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import dotenv from 'dotenv';

dotenv.config();

const url = new URL('https://n8n.parris.app/mcp-server/http');
const token = process.env.N8N_ACCESS_TOKEN;
const apiKey = process.env.N8N_API_KEY;
const workflowId = 'KJHvf5E2uuo9Zfam';

async function main() {
  const headers = {
    'X-N8N-API-KEY': apiKey,
    'Content-Type': 'application/json',
  };

  // 1. Fetch current details via REST API
  console.log('Fetching workflow details from REST API...');
  const getRes = await fetch(`https://n8n.parris.app/api/v1/workflows/${workflowId}`, { headers });
  const fullWf = await getRes.json();

  console.log('Current settings:', JSON.stringify(fullWf.settings, null, 2));

  // 2. Toggle availableInMCP to true via REST API PUT
  console.log('Toggling availableInMCP to true via REST API PUT...');
  const putRes = await fetch(`https://n8n.parris.app/api/v1/workflows/${workflowId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      name: fullWf.name,
      nodes: fullWf.nodes,
      connections: fullWf.connections,
      settings: {
        ...fullWf.settings,
        availableInMCP: true
      }
    })
  });
  console.log('PUT Status:', putRes.status);

  // 3. Connect to MCP and query details
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
  const text = mcpRes.content?.[0]?.text || '{}';
  const details = JSON.parse(text).workflow || JSON.parse(text);
  
  console.log('MCP Response parentFolderId:', details.parentFolderId);
  console.log('MCP Response full payload keys:', Object.keys(details));

  await transport.close();
}

main().catch(console.error);
