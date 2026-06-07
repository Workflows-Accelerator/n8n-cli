import fs from 'fs';
import path from 'path';

function searchDir(dir, query) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules') {
        searchDir(fullPath, query);
      }
    } else if (file.endsWith('.js') || file.endsWith('.json')) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      if (content.includes(query)) {
        console.log(`Found "${query}" in: ${fullPath}`);
      }
    }
  }
}

const sdkDir = 'c:\\Users\\lucas\\Documents\\Code\\n8n\\n8n-cli\\node_modules\\@modelcontextprotocol\\sdk';
searchDir(sdkDir, 'StreamableHTTPClientTransport');
searchDir(sdkDir, 'HTTPClientTransport');
