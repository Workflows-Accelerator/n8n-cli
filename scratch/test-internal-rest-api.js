import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.N8N_API_KEY;

async function testUrl(url) {
  console.log(`Testing ${url} with X-N8N-API-KEY...`);
  try {
    const res = await fetch(url, {
      headers: { 'X-N8N-API-KEY': apiKey }
    });
    console.log(`Status: ${res.status}`);
    if (res.ok) {
      const data = await res.json();
      console.log('Keys/Summary:', Object.keys(data));
      if (Array.isArray(data)) {
        console.log('First item sample:', JSON.stringify(data[0], null, 2).substring(0, 1000));
      } else if (data.data) {
        console.log('First item data sample:', JSON.stringify(data.data[0], null, 2).substring(0, 1000));
      } else {
        console.log('Response sample:', JSON.stringify(data, null, 2).substring(0, 1000));
      }
    } else {
      const text = await res.text();
      console.log('Error body:', text.substring(0, 500));
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

async function main() {
  await testUrl(`https://n8n.parris.app/rest/workflows`);
  await testUrl(`https://n8n.parris.app/rest/folders`);
}

main().catch(console.error);
