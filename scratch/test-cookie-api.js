import dotenv from 'dotenv';
dotenv.config();

const cookie = process.env.N8N_COOKIE;
const instanceUrl = 'https://n8n.parris.app';

async function main() {
  if (!cookie) {
    console.error('N8N_COOKIE is not defined in .env');
    process.exit(1);
  }

  console.log('Fetching internal workflows with N8N_COOKIE...');
  const res = await fetch(`${instanceUrl}/rest/workflows`, {
    headers: {
      'Cookie': cookie,
      'Content-Type': 'application/json'
    }
  });

  console.log('Status:', res.status);
  if (res.ok) {
    const data = await res.json();
    console.log('Workflows returned:', Array.isArray(data) ? data.length : (data.data ? data.data.length : 'not an array'));
    
    const list = Array.isArray(data) ? data : (data.data || []);
    if (list.length > 0) {
      console.log('Example workflow keys:', Object.keys(list[0]));
      
      // Let's find "AI Test Workflow in Folder" (ID: yY6V4ckA4Re4AKSz)
      const target = list.find(w => w.id === 'yY6V4ckA4Re4AKSz');
      if (target) {
        console.log('AI Test Workflow in Folder details:', JSON.stringify(target, null, 2));
      } else {
        console.log('First workflow details:', JSON.stringify(list[0], null, 2));
      }

      // Check folder fields for all workflows
      const withFolders = list.filter(w => w.parentFolderId || w.folderId);
      console.log(`\nWorkflows with folder fields: ${withFolders.length}/${list.length}`);
      for (const w of withFolders.slice(0, 5)) {
        console.log(`- "${w.name}" (id: ${w.id}) -> parentFolderId: ${w.parentFolderId}, folderId: ${w.folderId}`);
      }
    }
  } else {
    const text = await res.text();
    console.log('Error response:', text.substring(0, 500));
  }
}

main().catch(console.error);
