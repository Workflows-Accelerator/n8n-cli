import fs from 'fs';
import path from 'path';

const workflowsDir = path.resolve('n8n_dev/workflows');
console.log('Workflows Dir:', workflowsDir);
console.log('Exists:', fs.existsSync(workflowsDir));

const getJsonFiles = (dir) => {
  let results = [];
  try {
    const list = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of list) {
      const filePath = path.join(dir, file.name);
      if (file.isDirectory()) {
        results = results.concat(getJsonFiles(filePath));
      } else if (file.isFile() && file.name.endsWith('.json') && file.name !== 'sync-state.json' && file.name !== 'workflow-folders.json') {
        results.push(filePath);
      }
    }
  } catch (e) {
    console.error('Error reading dir:', dir, e);
  }
  return results;
};

const jsonFiles = getJsonFiles(workflowsDir);
console.log('Found JSON files:', jsonFiles);

for (const jsonPath of jsonFiles) {
  try {
    const content = fs.readFileSync(jsonPath, 'utf-8');
    const parsed = JSON.parse(content);
    
    const isWf = parsed && (Array.isArray(parsed.nodes) || parsed.connections);
    console.log(`File: ${jsonPath}, Is workflow heuristic match: ${isWf}`);
  } catch (e) {
    console.error('Error parsing:', jsonPath, e);
  }
}
