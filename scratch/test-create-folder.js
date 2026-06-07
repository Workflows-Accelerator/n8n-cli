import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const url = new URL('https://n8n.parris.app/mcp-server/http');
const token = process.env.N8N_ACCESS_TOKEN;
const projectId = '5U5vIHIc1Ug5eVLK';
const folderId = '3JiyzwujIPklu0w8'; // AI Examples folder

async function main() {
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

  const code = `
const wf = workflow('ai-test-workflow-in-folder', 'AI Test Workflow in Folder', {
  executionOrder: 'v1'
});
export default wf;
`;

  console.log('Creating workflow inside folder 3JiyzwujIPklu0w8...');
  const createRes = await client.callTool({
    name: 'create_workflow_from_code',
    arguments: {
      code,
      projectId,
      folderId,
      name: 'AI Test Workflow in Folder',
      description: 'Test workflow to see if it is correctly assigned to the folder 3JiyzwujIPklu0w8'
    }
  });

  console.log('Create response:', JSON.stringify(createRes, null, 2));

  await transport.close();
}

main().catch(console.error);
