import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.N8N_API_KEY;
const folderId = '3JiyzwujIPklu0w8';

async function testUrl(url) {
  console.log(`Testing ${url}...`);
  try {
    const res = await fetch(url, {
      headers: { 'X-N8N-API-KEY': apiKey }
    });
    console.log(`Status: ${res.status}`);
    if (res.ok) {
      const data = await res.json();
      console.log('Response:', JSON.stringify(data, null, 2).substring(0, 1000));
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

async function main() {
  await testUrl(`https://n8n.parris.app/api/v1/folders/${folderId}/workflows`);
  await testUrl(`https://n8n.parris.app/api/v1/workflows?folderId=${folderId}`);
  await testUrl(`https://n8n.parris.app/api/v1/workflows?parentFolderId=${folderId}`);
}

main().catch(console.error);
