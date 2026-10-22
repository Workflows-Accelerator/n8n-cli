import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { parseWorkflowCodeToBuilder } from '@n8n/workflow-sdk';

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
  workflowJson: any,
  projectId?: string
): Promise<void> {
  if (!client || !workflowId || !workflowJson) return;

  const nodesJson = JSON.stringify(workflowJson.nodes || []);
  const connectionsJson = JSON.stringify(workflowJson.connections || {});

  try {
    // Determine schema dynamically
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

    // Ensure shared_workflow record and workflow_entity projectId exist
    if (projectId) {
      try {
        const shareCheck = await client.query(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_name = 'shared_workflow' LIMIT 1;
        `);
        if (shareCheck.rows.length > 0) {
          try {
            await client.query(`
              INSERT INTO "${schema}"."shared_workflow" ("workflowId", "projectId", "role", "createdAt", "updatedAt")
              VALUES ($1, $2, 'workflow:owner', NOW(), NOW())
              ON CONFLICT DO NOTHING;
            `, [workflowId, projectId]);
          } catch (e) {
            try {
              await client.query(`
                INSERT INTO "${schema}"."shared_workflow" ("workflowId", "projectId", "role", "createdAt", "updatedAt")
                VALUES ($1, $2, 'workflow:owner', NOW(), NOW());
              `, [workflowId, projectId]);
            } catch (e2) {}
          }
        }
      } catch (e) {}

      try {
        const wfCols = await client.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name = 'workflow_entity';`
        );
        const colNames = wfCols.rows.map((r: any) => r.column_name);
        if (colNames.includes('projectId')) {
          await client.query(
            `UPDATE "${schema}"."workflow_entity" SET "projectId" = $1 WHERE "id" = $2 AND ("projectId" IS NULL OR "projectId" != $1);`,
            [projectId, workflowId]
          );
        }
      } catch (e) {}
    }

    // 1. Check/Ensure version snapshot exists in workflow_history
    let currentVersionId: string | null = null;
    try {
      const histCheck = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_name = 'workflow_history' LIMIT 1;
      `);
      if (histCheck.rows.length > 0) {
        const histRows = await client.query(
          `SELECT "versionId", "id" FROM "${schema}"."workflow_history" WHERE "workflowId" = $1 ORDER BY "createdAt" DESC LIMIT 1;`,
          [workflowId]
        );
        if (histRows.rows.length > 0) {
          currentVersionId = histRows.rows[0].versionId || histRows.rows[0].id;
          try {
            await client.query(
              `UPDATE "${schema}"."workflow_history" 
               SET "nodes" = $1::jsonb, "connections" = $2::jsonb, "updatedAt" = NOW() 
               WHERE "workflowId" = $3;`,
              [nodesJson, connectionsJson, workflowId]
            );
          } catch (e) {
            await client.query(
              `UPDATE "${schema}"."workflow_history" 
               SET "nodes" = $1, "connections" = $2, "updatedAt" = NOW() 
               WHERE "workflowId" = $3;`,
              [nodesJson, connectionsJson, workflowId]
            );
          }
        } else {
          // Generate new versionId and insert snapshot
          const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
          let newVerId = '';
          for (let i = 0; i < 16; i++) {
            newVerId += chars.charAt(Math.floor(Math.random() * chars.length));
          }
          currentVersionId = newVerId;
          try {
            await client.query(
              `INSERT INTO "${schema}"."workflow_history" ("versionId", "workflowId", "nodes", "connections", "createdAt", "updatedAt") 
               VALUES ($1, $2, $3::jsonb, $4::jsonb, NOW(), NOW());`,
              [newVerId, workflowId, nodesJson, connectionsJson]
            );
          } catch (e) {
            try {
              await client.query(
                `INSERT INTO "${schema}"."workflow_history" ("versionId", "workflowId", "nodes", "connections", "createdAt", "updatedAt") 
                 VALUES ($1, $2, $3, $4, NOW(), NOW());`,
                [newVerId, workflowId, nodesJson, connectionsJson]
              );
            } catch (err) {}
          }
        }
      }
    } catch (e) {}

    // 2. Update workflow_entity directly and set activeVersionId/unarchive if columns exist
    try {
      const wfCols = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'workflow_entity';`
      );
      const colNames = wfCols.rows.map((r: any) => r.column_name);
      
      const hasArchivedCol = colNames.includes('isArchived');
      const archiveSetClause = hasArchivedCol ? `, "isArchived" = false, "archivedAt" = NULL` : '';
      const nameClause = workflowJson.name ? `, "name" = $${colNames.includes('activeVersionId') && currentVersionId ? 5 : 4}` : '';

      if (colNames.includes('activeVersionId') && currentVersionId) {
        const queryParams = [nodesJson, connectionsJson, currentVersionId, workflowId];
        if (workflowJson.name) queryParams.push(workflowJson.name);
        try {
          await client.query(
            `UPDATE "${schema}"."workflow_entity" 
             SET "nodes" = $1::jsonb, "connections" = $2::jsonb, "activeVersionId" = $3${archiveSetClause}${nameClause}, "updatedAt" = NOW() 
             WHERE "id" = $4;`,
            queryParams
          );
        } catch (e) {
          await client.query(
            `UPDATE "${schema}"."workflow_entity" 
             SET "nodes" = $1, "connections" = $2, "activeVersionId" = $3${archiveSetClause}${nameClause}, "updatedAt" = NOW() 
             WHERE "id" = $4;`,
            queryParams
          );
        }
      } else {
        const queryParams = [nodesJson, connectionsJson, workflowId];
        if (workflowJson.name) queryParams.push(workflowJson.name);
        try {
          await client.query(
            `UPDATE "${schema}"."workflow_entity" 
             SET "nodes" = $1::jsonb, "connections" = $2::jsonb${archiveSetClause}${nameClause}, "updatedAt" = NOW() 
             WHERE "id" = $3;`,
            queryParams
          );
        } catch (e) {
          await client.query(
            `UPDATE "${schema}"."workflow_entity" 
             SET "nodes" = $1, "connections" = $2${archiveSetClause}${nameClause}, "updatedAt" = NOW() 
             WHERE "id" = $3;`,
            queryParams
          );
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

    // 4. Synchronize webhook_entity table for active webhooks if table exists
    try {
      const hookCheck = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_name = 'webhook_entity' LIMIT 1;
      `);
      if (hookCheck.rows.length > 0) {
        const nodes = workflowJson.nodes || [];
        for (const node of nodes) {
          const typeLower = (node.type || '').toLowerCase();
          if (typeLower.includes('webhook') || typeLower.includes('form') || typeLower.includes('trigger')) {
            const pathVal = node.parameters?.path || node.parameters?.endpoint || node.name;
            const httpMethod = (node.parameters?.httpMethod || 'GET').toUpperCase();
            if (pathVal) {
              try {
                await client.query(
                  `UPDATE "${schema}"."webhook_entity" 
                   SET "webhookPath" = $1, "method" = $2, "node" = $3 
                   WHERE "workflowId" = $4 AND "node" = $3;`,
                  [pathVal, httpMethod, node.name, workflowId]
                );
              } catch (e) {}
            }
          }
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

  // Strip 'n8n/workflows/' or 'workflows/' prefix if target included it
  let cleanTarget = normTarget;
  if (cleanTarget.startsWith('n8n/workflows/')) {
    cleanTarget = cleanTarget.slice(14);
  } else if (cleanTarget.startsWith('workflows/')) {
    cleanTarget = cleanTarget.slice(10);
  }

  // 1. Direct match on relative path or file
  if (normRelPath === cleanTarget || normRelPath === `${cleanTarget}.workflow.ts`) return true;

  // 2. Folder prefix match (e.g. target is "API/Document Processing/Propounding", matches "API/Document Processing/Propounding/Workflow.workflow.ts")
  if (normRelPath.startsWith(`${cleanTarget}/`) || normRelPath.toLowerCase().startsWith(`${cleanTarget.toLowerCase()}/`)) return true;

  // 3. Match workflow ID
  if (workflowId && workflowId === targetArg.trim()) return true;

  // 4. Match filename or workflow name (case-insensitive)
  const targetBase = path.basename(cleanTarget, '.workflow.ts').toLowerCase();
  const filenameBase = path.basename(normRelPath, '.workflow.ts').toLowerCase();
  if (filenameBase === targetBase) return true;
  if (workflowName && workflowName.toLowerCase() === targetBase) return true;

  return false;
}

/**
 * Fetches all remote workflows from n8n MCP tool, handling pagination to avoid limit truncation.
 */
export async function fetchAllRemoteWorkflows(mcp: any, options: { projectId?: string } = {}): Promise<any[]> {
  const allWorkflows: any[] = [];
  const seenIds = new Set<string>();
  let offset = 0;
  const limit = 200;

  while (true) {
    try {
      const searchResult = await mcp.callToolAndGetJson('search_workflows', {
        projectId: options.projectId,
        limit,
        offset,
      });
      const list = Array.isArray(searchResult) ? searchResult : (searchResult.data || searchResult.workflows || []);
      if (!list || list.length === 0) break;

      let newItemsAdded = 0;
      for (const item of list) {
        if (item && item.id && !seenIds.has(String(item.id))) {
          seenIds.add(String(item.id));
          allWorkflows.push(item);
          newItemsAdded++;
        }
      }

      if (list.length < limit || newItemsAdded === 0) break;
      offset += limit;
    } catch (err) {
      break;
    }
  }

  return allWorkflows;
}

/**
 * Generates a deterministic structural fingerprint for a workflow based on its nodes and connection topology.
 */
export function getWorkflowFingerprint(nodes: any[] = [], connections: any = {}): string {
  const normNodes = (nodes || []).map(n => {
    const paramKeys = n.parameters ? Object.keys(n.parameters).sort() : [];
    return {
      name: n.name || '',
      type: n.type || '',
      typeVersion: n.typeVersion || 1,
      parameterKeys: paramKeys,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const sortedConn: Record<string, any> = {};
  const connKeys = Object.keys(connections || {}).sort();
  for (const srcNode of connKeys) {
    sortedConn[srcNode] = connections[srcNode];
  }

  const payload = JSON.stringify({ nodes: normNodes, connections: sortedConn });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Recovers a lost workflow ID from sync-state, embedded JSON, or cached workflow files on disk.
 */
export function recoverWorkflowIdFromCacheOrState(
  repoRoot: string,
  localPath: string,
  code: string,
  syncState: SyncState,
  localDir: string = 'n8n'
): string | null {
  const stateEntry = syncState.workflows[localPath];
  if (stateEntry && stateEntry.id) return stateEntry.id;

  try {
    const builder = parseWorkflowCodeToBuilder(code);
    const json = builder.toJSON();
    if (json && json.id) return String(json.id);
  } catch (e) {}

  const cacheDir = path.join(repoRoot, localDir, 'config', 'cache', 'workflows');
  if (fs.existsSync(cacheDir)) {
    try {
      const files = fs.readdirSync(cacheDir);
      const cleanCode = code.replace(/\s+/g, '');
      for (const file of files) {
        if (file.endsWith('.workflow.ts')) {
          const cachedContent = fs.readFileSync(path.join(cacheDir, file), 'utf-8');
          if (cachedContent.replace(/\s+/g, '') === cleanCode) {
            return file.replace(/\.workflow\.ts$/, '');
          }
        }
      }
    } catch (e) {}
  }

  return null;
}

export interface WorkflowResolutionResult {
  remoteWorkflow: any | null;
  matchReason: 'id' | 'cache' | 'fingerprint' | 'name' | null;
}

/**
 * Resolves a local workflow to a remote n8n workflow using a robust 4-tier hierarchy:
 * Tier 1: Direct ID Match
 * Tier 2: Recovered Cache ID Match
 * Tier 3: Node Structural Fingerprint Match
 * Tier 4: Case-insensitive Name Match (Active & Archived)
 */
export function resolveRemoteWorkflow(
  localFile: { localPath: string; code?: string; name: string; localId?: string; json?: any },
  remoteWorkflows: any[],
  repoRoot: string,
  syncState: SyncState,
  localDir: string = 'n8n'
): WorkflowResolutionResult {
  if (!remoteWorkflows || remoteWorkflows.length === 0) {
    return { remoteWorkflow: null, matchReason: null };
  }

  let localJson = localFile.json;
  if (!localJson && localFile.code) {
    try {
      localJson = parseWorkflowCodeToBuilder(localFile.code).toJSON();
    } catch (e) {}
  }

  const effectiveId = localFile.localId || localJson?.id || syncState.workflows[localFile.localPath]?.id;

  // Tier 1: Direct ID Match
  if (effectiveId) {
    const match = remoteWorkflows.find(w => String(w.id) === String(effectiveId));
    if (match) return { remoteWorkflow: match, matchReason: 'id' };
  }

  // Tier 2: Cache-based Recovered ID Match
  if (localFile.code) {
    const recoveredId = recoverWorkflowIdFromCacheOrState(repoRoot, localFile.localPath, localFile.code, syncState, localDir);
    if (recoveredId) {
      const match = remoteWorkflows.find(w => String(w.id) === String(recoveredId));
      if (match) return { remoteWorkflow: match, matchReason: 'cache' };
    }
  }

  // Tier 3: Node Structural Fingerprint Match
  if (localJson && localJson.nodes) {
    const localFingerprint = getWorkflowFingerprint(localJson.nodes, localJson.connections);
    for (const rw of remoteWorkflows) {
      if (rw.nodes) {
        const remoteFingerprint = getWorkflowFingerprint(rw.nodes, rw.connections);
        if (localFingerprint === remoteFingerprint) {
          return { remoteWorkflow: rw, matchReason: 'fingerprint' };
        }
      }
    }
  }

  // Tier 4: Trimmed Case-Insensitive Name Match
  const targetName = localFile.name.trim().toLowerCase();
  const matchByName = remoteWorkflows.find(w => w.name && w.name.trim().toLowerCase() === targetName);
  if (matchByName) {
    return { remoteWorkflow: matchByName, matchReason: 'name' };
  }

  return { remoteWorkflow: null, matchReason: null };
}

/**
 * Surgically purges remote UI-generated duplicate workflow records that overlap in name/path with canonical repository files.
 * Cleans across workflow_entity, webhook_entity, workflow_history, workflow_published_version, and shared_workflow.
 */
export async function purgeOrphanedRemoteWorkflows(
  pgClient: any,
  canonicalWorkflows: Array<{ id: string; name: string; localPath: string }>,
  remoteWorkflows: any[]
): Promise<{ prunedCount: number; prunedIds: string[] }> {
  if (!pgClient || !remoteWorkflows || remoteWorkflows.length === 0) {
    return { prunedCount: 0, prunedIds: [] };
  }

  const canonicalIds = new Set(canonicalWorkflows.map(w => String(w.id)));
  const canonicalNames = new Set(canonicalWorkflows.map(w => w.name.trim().toLowerCase()));

  const orphanedWorkflows = remoteWorkflows.filter(w => 
    canonicalNames.has(String(w.name).trim().toLowerCase()) && !canonicalIds.has(String(w.id))
  );

  if (orphanedWorkflows.length === 0) {
    return { prunedCount: 0, prunedIds: [] };
  }

  const orphanedIds = orphanedWorkflows.map(w => String(w.id));

  let schema = 'public';
  try {
    const colsRes = await pgClient.query(`
      SELECT table_schema FROM information_schema.columns WHERE table_name = 'workflow_entity' LIMIT 1;
    `);
    if (colsRes.rows.length > 0) schema = colsRes.rows[0].table_schema;
  } catch (e) {}

  for (const orphanId of orphanedIds) {
    try {
      await pgClient.query(`DELETE FROM "${schema}"."webhook_entity" WHERE "workflowId" = $1;`, [orphanId]);
    } catch (e) {}
    try {
      await pgClient.query(`DELETE FROM "${schema}"."workflow_history" WHERE "workflowId" = $1;`, [orphanId]);
    } catch (e) {}
    try {
      await pgClient.query(`DELETE FROM "${schema}"."workflow_published_version" WHERE "workflowId" = $1;`, [orphanId]);
    } catch (e) {}
    try {
      await pgClient.query(`DELETE FROM "${schema}"."shared_workflow" WHERE "workflowId" = $1;`, [orphanId]);
    } catch (e) {}
    try {
      await pgClient.query(`DELETE FROM "${schema}"."workflow_entity" WHERE "id" = $1;`, [orphanId]);
    } catch (e) {}
  }

  return { prunedCount: orphanedIds.length, prunedIds: orphanedIds };
}

export function chunkOperations<T>(operations: T[], maxBatchSize: number = 100): T[][] {
  if (!operations || operations.length === 0) return [];
  const batches: T[][] = [];
  for (let i = 0; i < operations.length; i += maxBatchSize) {
    batches.push(operations.slice(i, i + maxBatchSize));
  }
  return batches;
}

interface NormalizedConnection {
  source: string;
  target: string;
  sourceIndex: number;
  targetIndex: number;
  connectionType: string;
}

function extractConnections(connectionsObj: any): NormalizedConnection[] {
  const result: NormalizedConnection[] = [];
  if (!connectionsObj || typeof connectionsObj !== 'object') return result;
  for (const [source, connTypes] of Object.entries(connectionsObj)) {
    if (!connTypes || typeof connTypes !== 'object') continue;
    for (const [connType, outputArray] of Object.entries(connTypes as Record<string, any>)) {
      if (!Array.isArray(outputArray)) continue;
      outputArray.forEach((targets: any, sourceIndex: number) => {
        if (!Array.isArray(targets)) return;
        for (const targetItem of targets) {
          if (!targetItem || !targetItem.node) continue;
          result.push({
            source,
            target: targetItem.node,
            sourceIndex,
            targetIndex: typeof targetItem.index === 'number' ? targetItem.index : 0,
            connectionType: connType || targetItem.type || 'main',
          });
        }
      });
    }
  }
  return result;
}

export function generateWorkflowUpdateOperations(localWf: any, remoteWf?: any): any[] {
  const operations: any[] = [];
  if (!localWf) return operations;

  const remote = remoteWf || { nodes: [], connections: {}, settings: {} };

  // 1. Connection diffing
  const localConns = extractConnections(localWf.connections);
  const remoteConns = extractConnections(remote.connections);

  const connKey = (c: NormalizedConnection) =>
    `${c.source}::${c.sourceIndex}::${c.connectionType}::${c.target}::${c.targetIndex}`;

  const localConnKeySet = new Set(localConns.map(connKey));
  const remoteConnKeySet = new Set(remoteConns.map(connKey));

  const connsToRemove = remoteConns.filter(rc => !localConnKeySet.has(connKey(rc)));
  const connsToAdd = localConns.filter(lc => !remoteConnKeySet.has(connKey(lc)));

  // Remove connections first (before nodes are removed)
  for (const rc of connsToRemove) {
    operations.push({
      type: 'removeConnection',
      source: rc.source,
      target: rc.target,
      sourceIndex: rc.sourceIndex,
      targetIndex: rc.targetIndex,
      connectionType: rc.connectionType,
    });
  }

  // 2. Node diffing
  const localNodes: any[] = localWf.nodes || [];
  const remoteNodes: any[] = remote.nodes || [];

  const localNodesMap = new Map<string, any>(localNodes.map(n => [n.name, n]));
  const remoteNodesMap = new Map<string, any>(remoteNodes.map(n => [n.name, n]));

  // Nodes to remove
  for (const rn of remoteNodes) {
    if (!localNodesMap.has(rn.name)) {
      operations.push({
        type: 'removeNode',
        nodeName: rn.name,
      });
    }
  }

  // Nodes to add
  for (const ln of localNodes) {
    if (!remoteNodesMap.has(ln.name)) {
      const nodePayload: any = {
        name: ln.name,
        type: ln.type,
        typeVersion: typeof ln.typeVersion === 'number' ? ln.typeVersion : 1,
      };
      if (ln.parameters && Object.keys(ln.parameters).length > 0) {
        nodePayload.parameters = ln.parameters;
      }
      if (Array.isArray(ln.position) && ln.position.length === 2) {
        nodePayload.position = [ln.position[0], ln.position[1]];
      }
      if (ln.credentials && Object.keys(ln.credentials).length > 0) {
        nodePayload.credentials = ln.credentials;
      }
      if (typeof ln.disabled === 'boolean') {
        nodePayload.disabled = ln.disabled;
      }
      if (ln.notes !== undefined && ln.notes !== null) {
        nodePayload.notes = ln.notes;
      }
      operations.push({
        type: 'addNode',
        node: nodePayload,
      });
    }
  }

  // Nodes to update (present in both)
  for (const ln of localNodes) {
    const rn = remoteNodesMap.get(ln.name);
    if (!rn) continue;

    // Parameters
    const localParamsStr = JSON.stringify(ln.parameters || {});
    const remoteParamsStr = JSON.stringify(rn.parameters || {});
    if (localParamsStr !== remoteParamsStr) {
      operations.push({
        type: 'updateNodeParameters',
        nodeName: ln.name,
        parameters: ln.parameters || {},
        replace: true,
      });
    }

    // Position
    if (
      Array.isArray(ln.position) &&
      ln.position.length === 2 &&
      (!Array.isArray(rn.position) ||
        ln.position[0] !== rn.position[0] ||
        ln.position[1] !== rn.position[1])
    ) {
      operations.push({
        type: 'setNodePosition',
        nodeName: ln.name,
        position: [ln.position[0], ln.position[1]],
      });
    }

    // Disabled
    if (Boolean(ln.disabled) !== Boolean(rn.disabled)) {
      operations.push({
        type: 'setNodeDisabled',
        nodeName: ln.name,
        disabled: Boolean(ln.disabled),
      });
    }

    // Node settings
    if (ln.settings || rn.settings) {
      const localSettingsStr = JSON.stringify(ln.settings || {});
      const remoteSettingsStr = JSON.stringify(rn.settings || {});
      if (localSettingsStr !== remoteSettingsStr && ln.settings) {
        operations.push({
          type: 'setNodeSettings',
          nodeName: ln.name,
          settings: ln.settings,
        });
      }
    }

    // Credentials
    if (ln.credentials && typeof ln.credentials === 'object') {
      const remoteCreds = rn.credentials || {};
      for (const [credKey, credVal] of Object.entries(ln.credentials as Record<string, any>)) {
        if (!credVal) continue;
        const remoteVal = remoteCreds[credKey];
        if (!remoteVal || remoteVal.id !== credVal.id || remoteVal.name !== credVal.name) {
          const op: any = {
            type: 'setNodeCredential',
            nodeName: ln.name,
            credentialKey: credKey,
          };
          if (credVal.id) op.credentialId = credVal.id;
          if (credVal.name) op.credentialName = credVal.name;
          operations.push(op);
        }
      }
    }
  }

  // Add new connections (now all target and source nodes exist)
  for (const lc of connsToAdd) {
    operations.push({
      type: 'addConnection',
      source: lc.source,
      target: lc.target,
      sourceIndex: lc.sourceIndex,
      targetIndex: lc.targetIndex,
      connectionType: lc.connectionType,
    });
  }

  // Workflow metadata (name)
  if (localWf.name && localWf.name !== remote.name) {
    operations.push({
      type: 'setWorkflowMetadata',
      name: localWf.name,
    });
  }

  // Workflow settings
  const supportedSettingsKeys = [
    'onError',
    'retryOnFail',
    'maxTries',
    'waitBetweenTries',
    'alwaysOutputData',
    'executeOnce',
    'errorWorkflow',
    'timezone',
    'executionOrder',
    'saveExecutionProgress',
    'saveManualExecutions',
    'saveDataErrorExecution',
    'saveDataSuccessExecution',
    'executionTimeout',
    'timeSavedPerExecution',
    'callerPolicy',
    'callerIds',
  ];

  if (localWf.settings && typeof localWf.settings === 'object') {
    const sanitizedLocalSettings: Record<string, any> = {};
    for (const key of supportedSettingsKeys) {
      if (localWf.settings[key] !== undefined) {
        sanitizedLocalSettings[key] = localWf.settings[key];
      }
    }
    const sanitizedRemoteSettings: Record<string, any> = {};
    if (remote.settings && typeof remote.settings === 'object') {
      for (const key of supportedSettingsKeys) {
        if (remote.settings[key] !== undefined) {
          sanitizedRemoteSettings[key] = remote.settings[key];
        }
      }
    }

    if (
      Object.keys(sanitizedLocalSettings).length > 0 &&
      JSON.stringify(sanitizedLocalSettings) !== JSON.stringify(sanitizedRemoteSettings)
    ) {
      operations.push({
        type: 'setWorkflowSettings',
        settings: sanitizedLocalSettings,
      });
    }
  }

  return operations;
}


/**
 * Surgically rekeys an existing remote workflow's primary key ID in PostgreSQL database tables
 * to match the declared workflow ID in local code, preventing duplicate remote workflows.
 */
export async function rekeyRemoteWorkflowId(
  pgClient: any,
  oldId: string,
  newId: string
): Promise<boolean> {
  if (!pgClient || !oldId || !newId || oldId === newId) {
    return false;
  }

  let schema = 'public';
  try {
    const colsRes = await pgClient.query(`
      SELECT table_schema FROM information_schema.columns WHERE table_name = 'workflow_entity' LIMIT 1;
    `);
    if (colsRes.rows.length > 0) schema = colsRes.rows[0].table_schema;
  } catch (e) {}

  try {
    const checkRes = await pgClient.query(`SELECT id FROM "${schema}"."workflow_entity" WHERE id = $1;`, [newId]);
    if (checkRes.rows.length > 0) {
      // New ID already exists on remote, delete old duplicate record
      await pgClient.query(`DELETE FROM "${schema}"."webhook_entity" WHERE "workflowId" = $1;`, [oldId]);
      await pgClient.query(`DELETE FROM "${schema}"."workflow_history" WHERE "workflowId" = $1;`, [oldId]);
      await pgClient.query(`DELETE FROM "${schema}"."workflow_published_version" WHERE "workflowId" = $1;`, [oldId]);
      await pgClient.query(`DELETE FROM "${schema}"."shared_workflow" WHERE "workflowId" = $1;`, [oldId]);
      await pgClient.query(`DELETE FROM "${schema}"."execution_entity" WHERE "workflowId" = $1;`, [oldId]);
      await pgClient.query(`DELETE FROM "${schema}"."workflow_entity" WHERE id = $1;`, [oldId]);
      return true;
    }

    const fkTables = [
      { table: 'webhook_entity', col: 'workflowId' },
      { table: 'workflow_history', col: 'workflowId' },
      { table: 'workflow_published_version', col: 'workflowId' },
      { table: 'shared_workflow', col: 'workflowId' },
      { table: 'workflows_tags', col: 'workflowId' },
      { table: 'workflow_dependency', col: 'workflowId' },
      { table: 'execution_entity', col: 'workflowId' },
    ];

    for (const item of fkTables) {
      try {
        await pgClient.query(`UPDATE "${schema}"."${item.table}" SET "${item.col}" = $1 WHERE "${item.col}" = $2;`, [newId, oldId]);
      } catch (e) {}
    }

    await pgClient.query(`UPDATE "${schema}"."workflow_entity" SET id = $1 WHERE id = $2;`, [newId, oldId]);
    return true;
  } catch (err) {
    return false;
  }
}


