import dotenv from 'dotenv';
dotenv.config();

const API_KEY = process.env.N8N_API_KEY;
const projectId = '5U5vIHIc1Ug5eVLK';

async function main() {
  const headers = { 'X-N8N-API-KEY': API_KEY };
  const res = await fetch(`https://n8n.parris.app/api/v1/workflows?projectId=${projectId}&limit=250`, { headers });
  const data = await res.json();
  const workflows = data.data || data.workflows || [];
  
  console.log('Workflows in project:', workflows.length);
  for (const w of workflows) {
    const detailRes = await fetch(`https://n8n.parris.app/api/v1/workflows/${w.id}`, { headers });
    const full = await detailRes.json();
    console.log(`- ID: ${full.id}, Name: "${full.name}", parentFolderId: "${full.parentFolderId}", availableInMCP: ${full.settings?.availableInMCP}, active: ${full.active}`);
  }
}

main().catch(console.error);
