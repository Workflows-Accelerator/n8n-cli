import dotenv from 'dotenv';
dotenv.config();

const cookie = process.env.N8N_COOKIE;
const instanceUrl = 'https://n8n.parris.app';

async function testWithHeaders() {
  if (!cookie) {
    console.error('No cookie');
    return;
  }

  const headers = {
    'Cookie': cookie,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive',
    'Origin': instanceUrl,
    'Referer': `${instanceUrl}/`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };

  const endpoints = ['/rest/workflows', '/rest/active-workflows'];

  for (const ep of endpoints) {
    console.log(`\nTesting ${ep} with browser headers...`);
    try {
      const res = await fetch(`${instanceUrl}${ep}`, { headers });
      console.log('Status:', res.status);
      const text = await res.text();
      console.log('Response:', text.substring(0, 500));
    } catch (e) {
      console.error('Error:', e.message);
    }
  }
}

testWithHeaders().catch(console.error);
