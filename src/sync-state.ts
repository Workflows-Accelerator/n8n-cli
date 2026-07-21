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

/**
 * Synchronize and invalidate workflow_entity, workflow_history, and workflow_published_version
 * tables directly in PostgreSQL to ensure the n8n execution engine immediately picks up code changes.
 */
export async function syncWorkflowVersionAndHistory(
  client: any,
  workflowId: string,
  workflowJson: any
): Promise<void> {
  if (!client || !workflowId || !workflowJson) return;

  const nodesJson = JSON.stringify(workflowJson.nodes || []);
  const connectionsJson = JSON.stringify(workflowJson.connections || {});

  try {
    // 1. Update workflow_entity directly
    let schema = 'public';
    try {
      const colsRes = await client.query(`
        SELECT table_schema
        FROM information_schema.columns 
        WHERE table_name = 'workflow_entity' LIMIT 1;
      `);
      if (colsRes.rows.length > 0) {
        schema = colsRes.rows[0].table_schema;
      }
    } catch (e) {}

    try {
      await client.query(
        `UPDATE "${schema}"."workflow_entity" 
         SET "nodes" = $1::jsonb, "connections" = $2::jsonb, "updatedAt" = NOW() 
         WHERE "id" = $3;`,
        [nodesJson, connectionsJson, workflowId]
      );
    } catch (e) {
      try {
        await client.query(
          `UPDATE "${schema}"."workflow_entity" 
           SET "nodes" = $1, "connections" = $2, "updatedAt" = NOW() 
           WHERE "id" = $3;`,
          [nodesJson, connectionsJson, workflowId]
        );
      } catch (err) {}
    }

    // 2. Invalidate/update workflow_history if table exists
    try {
      const histCheck = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_name = 'workflow_history' LIMIT 1;
      `);
      if (histCheck.rows.length > 0) {
        try {
          await client.query(
            `UPDATE "${schema}"."workflow_history" 
             SET "nodes" = $1::jsonb, "connections" = $2::jsonb, "updatedAt" = NOW() 
             WHERE "workflowId" = $3;`,
            [nodesJson, connectionsJson, workflowId]
          );
        } catch (e) {
          try {
            await client.query(
              `UPDATE "${schema}"."workflow_history" 
               SET "nodes" = $1, "connections" = $2, "updatedAt" = NOW() 
               WHERE "workflowId" = $3;`,
              [nodesJson, connectionsJson, workflowId]
            );
          } catch (e) {}
        }
      }
    } catch (e) {}

    // 3. Invalidate/update workflow_published_version if table exists
    try {
      const pubCheck = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_name = 'workflow_published_version' LIMIT 1;
      `);
      if (pubCheck.rows.length > 0) {
        try {
          await client.query(
            `UPDATE "${schema}"."workflow_published_version" 
             SET "nodes" = $1::jsonb, "connections" = $2::jsonb 
             WHERE "workflowId" = $3;`,
            [nodesJson, connectionsJson, workflowId]
          );
        } catch (e) {
          try {
            await client.query(
              `UPDATE "${schema}"."workflow_published_version" 
               SET "nodes" = $1, "connections" = $2 
               WHERE "workflowId" = $3;`,
              [nodesJson, connectionsJson, workflowId]
            );
          } catch (e) {}
        }
      }
    } catch (e) {}
  } catch (err) {
    // Fail silently on version sync attempts if DB permissions or tables differ
  }
}

/**
 * Determines whether a given relative workflow path, workflow ID, or workflow name
 * falls within the target scope specified by targetArg.
 * If targetArg is undefined or empty, returns true (everything is in scope).
 */
export function isTargetScoped(
  relPath: string,
  workflowId: string | undefined,
  workflowName: string | undefined,
  targetArg?: string
): boolean {
  if (!targetArg || targetArg.trim() === '') return true;

  const normTarget = targetArg.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
  const normRelPath = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
  
  // 1. Direct match on relative path
  if (normRelPath === normTarget || normRelPath === `${normTarget}.workflow.ts`) return true;

  // 2. Folder prefix match (e.g. target is "Leads" or "workflows/Leads", matches "Leads/Lead Router.workflow.ts")
  if (normRelPath.startsWith(`${normTarget}/`)) return true;
  
  // Strip 'workflows/' prefix if target included it
  const cleanTarget = normTarget.startsWith('workflows/') ? normTarget.slice(10) : normTarget;
  if (normRelPath.startsWith(`${cleanTarget}/`)) return true;

  // 3. Match workflow ID
  if (workflowId && workflowId === targetArg.trim()) return true;

  // 4. Match filename or workflow name (case-insensitive)
  const targetBase = path.basename(cleanTarget, '.workflow.ts').toLowerCase();
  const filenameBase = path.basename(normRelPath, '.workflow.ts').toLowerCase();
  if (filenameBase === targetBase) return true;
  if (workflowName && workflowName.toLowerCase() === targetBase) return true;

  return false;
}


