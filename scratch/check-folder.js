import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import dotenv from 'dotenv';

dotenv.config();

const url = new URL('https://n8n.parris.app/mcp-server/http');
const token = process.env.N8N_ACCESS_TOKEN;

async function main() {
  const workflowId = process.argv[2];
  if (!workflowId) {
    console.error('Please provide a workflow ID as an argument: node scratch/check-folder.js <id>');
    process.exit(1);
  }

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { 'Authorization': `Bearer ${token}` } }
  });
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  console.log(`Querying details for workflow ${workflowId}...`);
  const detailsRes = await client.callTool({
    name: 'get_workflow_details',
    arguments: { workflowId }
  });
  const text = detailsRes.content?.[0]?.text || '{}';
  const details = JSON.parse(text).workflow || JSON.parse(text);
  
  console.log('Fields related to folder or project:');
  console.log('parentFolderId:', details.parentFolderId);
  console.log('folderId:', details.folderId);
  console.log('projectId:', details.projectId);
  console.log('shared:', JSON.stringify(details.shared, null, 2));
  
  // Log all keys containing 'id' or 'project' or 'folder'
  const keys = Object.keys(details).filter(k => 
    k.toLowerCase().includes('id') || 
    k.toLowerCase().includes('project') || 
    k.toLowerCase().includes('folder')
  );
  console.log('\nKeys containing id/project/folder:');
  for (const k of keys) {
    console.log(`- ${k}:`, details[k]);
  }

  await transport.close();
}

main().catch(console.error);
