import { convertLocalJsonWorkflows } from '../dist/config.js';
import path from 'path';
import fs from 'fs';

const targetDir = path.resolve('n8n_dev/workflows');
console.log('Target dir:', targetDir);
console.log('Exists:', fs.existsSync(targetDir));

try {
  convertLocalJsonWorkflows(targetDir);
  console.log('Conversion check complete.');
} catch (err) {
  console.error('Error during conversion:', err);
}
