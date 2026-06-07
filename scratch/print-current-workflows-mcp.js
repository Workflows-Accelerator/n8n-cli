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

  console.log('Fetching workflows...');
  const searchRes = await client.callTool({
    name: 'search_workflows',
    arguments: { projectId, limit: 100 }
  });
  
  const workflows = searchRes.structuredContent?.data || [];
  console.log(`Total workflows: ${workflows.length}`);

  for (const w of workflows) {
    try {
      const detailsRes = await client.callTool({
        name: 'get_workflow_details',
        arguments: { workflowId: w.id }
      });
      const text = detailsRes.content?.[0]?.text || '{}';
      const details = JSON.parse(text).workflow || JSON.parse(text);
      if (details.parentFolderId) {
        console.log(`Workflow: "${details.name}" (ID: ${details.id}) -> parentFolderId: "${details.parentFolderId}"`);
      } else {
        // Log all fields of details to see if there's folderId or parentFolderId
        const keys = Object.keys(details).filter(k => k.toLowerCase().includes('folder'));
        if (keys.length > 0) {
          console.log(`Workflow: "${details.name}" (ID: ${details.id}) -> folder keys:`, keys.map(k => `${k}=${details[k]}`));
        } else {
          console.log(`Workflow: "${details.name}" (ID: ${details.id}) -> no folder fields`);
        }
      }
    } catch (err) {
      console.error(`Error for ${w.name}:`, err.message);
    }
  }

  await transport.close();
}

main().catch(console.error);
