import dotenv from 'dotenv';
dotenv.config();

const rawCookie = process.env.N8N_COOKIE;
const instanceUrl = 'https://n8n.parris.app';

async function main() {
  if (!rawCookie) {
    console.error('No N8N_COOKIE in .env');
    return;
  }
  
  let formattedCookie = rawCookie.trim();
  if (!formattedCookie.includes('=')) {
    formattedCookie = `n8n-auth=${formattedCookie}`;
  }
  
  console.log('Testing raw cookie...');
  await testWithCookie(rawCookie);
  
  console.log('\nTesting formatted cookie (with n8n-auth= prefix)...');
  await testWithCookie(formattedCookie);
}

async function testWithCookie(cookieHeaderValue) {
  try {
    const res = await fetch(`${instanceUrl}/rest/workflows`, {
      headers: {
        'Cookie': cookieHeaderValue,
        'Content-Type': 'application/json',
      },
    });
    console.log('Status:', res.status);
    if (res.ok) {
      const data = await res.json();
      console.log('Success! Sample keys:', Object.keys(data).slice(0, 5));
      const list = Array.isArray(data) ? data : (data.data || []);
      console.log('Number of workflows:', list.length);
    } else {
      const text = await res.text();
      console.log('Error Body:', text.substring(0, 100));
    }
  } catch (err) {
    console.error('Fetch error:', err.message);
  }
}

main().catch(console.error);
