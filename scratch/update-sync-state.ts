import fs from 'fs';
import path from 'path';
import { loadSyncState, saveSyncState, calculateHash } from '../src/sync-state.js';

const repoRoot = path.resolve('.');
const syncState = loadSyncState(repoRoot);

const rootWorkflowPath = path.join(repoRoot, 'n8n', 'workflows', 'Workflow at Root of target Folder.workflow.ts');
if (fs.existsSync(rootWorkflowPath)) {
  const content = fs.readFileSync(rootWorkflowPath, 'utf-8');
  const hash = calculateHash(content);
  syncState.workflows["Workflow at Root of target Folder.workflow.ts"] = {
    id: "cczgeo4inKplHEST",
    name: "Workflow at Root of target Folder",
    localPath: "Workflow at Root of target Folder.workflow.ts",
    contentHash: hash,
    remoteUpdatedAt: new Date().toISOString(),
    folderId: "Nz4UtQWrmrHMcZIE"
  };
  saveSyncState(repoRoot, syncState);
  console.log('Successfully added Workflow at Root of target Folder to sync-state.json');
} else {
  console.error('Workflow at Root of target Folder not found at root!');
}
