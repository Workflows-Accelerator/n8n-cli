import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const url = new URL('https://n8n.parris.app/mcp-server/http');
  const token = process.env.N8N_ACCESS_TOKEN;

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }
  });

  const client = new Client(
    { name: 'test-http-client', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  
  const tools = await client.listTools();
  const updateWorkflowTool = tools.tools.find(t => t.name === 'update_workflow');
  console.log('update_workflow tool schema:', JSON.stringify(updateWorkflowTool, null, 2));

  await transport.close();
}

main().catch(console.error);
