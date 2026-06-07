import dotenv from 'dotenv';
dotenv.config();

const cookie = process.env.N8N_COOKIE;
const instanceUrl = 'https://n8n.parris.app';

async function main() {
  if (!cookie) {
    console.error('No cookie in .env');
    return;
  }
  
  console.log('Testing raw fetch with N8N_COOKIE...');
  try {
    const res = await fetch(`${instanceUrl}/rest/workflows`, {
      headers: {
        'Cookie': cookie,
        'Content-Type': 'application/json',
      },
    });
    console.log('Status:', res.status);
    console.log('Headers:', Object.fromEntries(res.headers.entries()));
    const text = await res.text();
    console.log('Body:', text.substring(0, 1000));
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

main().catch(console.error);
