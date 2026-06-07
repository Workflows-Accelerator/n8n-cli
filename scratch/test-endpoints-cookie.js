import dotenv from 'dotenv';
dotenv.config();

const fullCookie = process.env.N8N_COOKIE;
const instanceUrl = 'https://n8n.parris.app';

async function testEndpoint(endpoint, cookieVal) {
  console.log(`\nTesting ${endpoint}...`);
  try {
    const res = await fetch(`${instanceUrl}${endpoint}`, {
      headers: {
        'Cookie': cookieVal,
        'Content-Type': 'application/json'
      }
    });
    console.log(`Status: ${res.status}`);
    if (res.ok) {
      const data = await res.json();
      console.log('Success! Keys:', Object.keys(data));
      if (Array.isArray(data)) {
        console.log(`Length: ${data.length}`);
        if (data.length > 0) {
          console.log('Sample item:', JSON.stringify(data[0]).substring(0, 500));
        }
      } else {
        console.log('Sample data:', JSON.stringify(data).substring(0, 500));
      }
      return true;
    } else {
      const text = await res.text();
      console.log('Error:', text.substring(0, 200));
      return false;
    }
  } catch (err) {
    console.error('Fetch error:', err.message);
    return false;
  }
}

async function main() {
  if (!fullCookie) {
    console.error('N8N_COOKIE is not defined in .env');
    process.exit(1);
  }

  // 1. Try with full cookie
  console.log('--- 1. Testing with full N8N_COOKIE ---');
  await testEndpoint('/rest/active-workflows', fullCookie);
  await testEndpoint('/rest/workflows', fullCookie);
  await testEndpoint('/rest/folders', fullCookie);
  await testEndpoint('/rest/users/me', fullCookie);

  // 2. Try with only n8n-auth cookie
  console.log('\n--- 2. Testing with only n8n-auth cookie ---');
  const authPart = fullCookie.split(';').map(p => p.trim()).find(p => p.startsWith('n8n-auth='));
  if (authPart) {
    console.log(`Extracted: ${authPart.substring(0, 30)}...`);
    await testEndpoint('/rest/active-workflows', authPart);
    await testEndpoint('/rest/workflows', authPart);
    await testEndpoint('/rest/folders', authPart);
    await testEndpoint('/rest/users/me', authPart);
  } else {
    console.log('No n8n-auth found in N8N_COOKIE!');
  }
}

main().catch(console.error);
