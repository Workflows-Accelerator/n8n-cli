import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface SyncWorkflowEntry {
  id: string;
  name: string;
  localPath: string;       // relative to n8n/workflows/ (with forward slashes for cross-platform)
  contentHash: string;     // hash of local file content
  remoteUpdatedAt: string; // remote updatedAt ISO timestamp
  folderId?: string;
  conflict?: boolean;      // flag to indicate conflict/locked status in live sync or pushes
}

export function getCacheFilePath(repoRoot: string, workflowId: string, localDir: string = 'n8n'): string {
  return path.join(repoRoot, localDir, 'config', 'cache', 'workflows', `${workflowId}.workflow.ts`);
}

export function saveWorkflowCache(repoRoot: string, workflowId: string, content: string, localDir: string = 'n8n') {
  const filePath = getCacheFilePath(repoRoot, workflowId, localDir);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function loadWorkflowCache(repoRoot: string, workflowId: string, localDir: string = 'n8n'): string | null {
  const filePath = getCacheFilePath(repoRoot, workflowId, localDir);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, 'utf-8');
}

export function deleteWorkflowCache(repoRoot: string, workflowId: string, localDir: string = 'n8n') {
  const filePath = getCacheFilePath(repoRoot, workflowId, localDir);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (e) {}
  }
}

export interface SyncState {
  lastSync: string; // ISO timestamp
  workflows: Record<string, SyncWorkflowEntry>; // local relative path -> entry
  folders?: string[]; // folder IDs present locally on last sync
}

export function loadSyncState(repoRoot: string, localDir: string = 'n8n'): SyncState {
  const syncStatePath = path.join(repoRoot, localDir, 'config', 'sync-state.json');
  if (!fs.existsSync(syncStatePath)) {
    return {
      lastSync: new Date(0).toISOString(),
      workflows: {},
    };
  }
  try {
    const content = fs.readFileSync(syncStatePath, 'utf-8');
    return JSON.parse(content) as SyncState;
  } catch (err) {
    // Return empty state if reading/parsing fails
    return {
      lastSync: new Date(0).toISOString(),
      workflows: {},
    };
  }
}

export function saveSyncState(repoRoot: string, state: SyncState, localDir: string = 'n8n') {
  const configDir = path.join(repoRoot, localDir, 'config');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  const syncStatePath = path.join(configDir, 'sync-state.json');
  fs.writeFileSync(syncStatePath, JSON.stringify(state, null, 2), 'utf-8');
}

export function calculateHash(content: string): string {
  // Normalize line endings to avoid git crlf/lf hashing discrepancies
  const normalized = content.replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
