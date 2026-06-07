import dotenv from 'dotenv';
dotenv.config();

const cookie = process.env.N8N_COOKIE;
const instanceUrl = 'https://n8n.parris.app';

async function main() {
  if (!cookie) {
    console.error('N8N_COOKIE is not defined in .env');
    process.exit(1);
  }

  console.log('Fetching internal active-workflows with N8N_COOKIE...');
  const res = await fetch(`${instanceUrl}/rest/active-workflows`, {
    headers: {
      'Cookie': cookie,
      'Content-Type': 'application/json'
    }
  });

  console.log('Status:', res.status);
  if (res.ok) {
    const data = await res.json();
    console.log('Data sample:', JSON.stringify(data, null, 2).substring(0, 1000));
  } else {
    const text = await res.text();
    console.log('Error response:', text.substring(0, 500));
  }
}

main().catch(console.error);
