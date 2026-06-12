import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { glob } from 'glob';
import { spawn } from 'child_process';
import {
  getConnectionInfo,
  buildFolderPaths,
  convertLocalJsonWorkflows,
  syncCredentials,
  fetchWorkflowsPaginated
} from '../config.js';
import { McpClient } from '../mcp-client.js';
import {
  loadSyncState,
  saveSyncState,
  calculateHash,
  saveWorkflowCache,
  loadWorkflowCache,
  deleteWorkflowCache,
  SyncState,
  SyncWorkflowEntry
} from '../sync-state.js';
import { showConflictDiff } from './diff.js';
import { generateWorkflowCode, parseWorkflowCodeToBuilder } from '@n8n/workflow-sdk';
import * as output from '../output.js';
import { autoLayoutIfChanged } from '../layout-engine.js';

export interface RemoteWorkflowMetadata {
  id: string;
  name: string;
  updatedAt: string;
  parentFolderId: string | null;
  isArchived: boolean;
}

export interface LiveConflictEntry {
  id: string;
  name: string;
  localPath: string;
  detectedAt: string;
  reason: string;
}

export interface LiveStatusFile {
  status: 'running' | 'stopped';
  lastCheck: string;
  pid: number;
  intervalSeconds: number;
  mode: 'db' | 'api';
  conflicts: LiveConflictEntry[];
  stopAt?: string;
}

export function writeLiveStatus(
  repoRoot: string,
  localDir: string,
  status: 'running' | 'stopped',
  intervalSeconds: number,
  mode: 'db' | 'api',
  conflicts: LiveConflictEntry[],
  stopAt?: string
) {
  const statusPath = path.join(repoRoot, localDir, 'config', 'live-status.json');
  const dir = path.dirname(statusPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const liveStatus: LiveStatusFile = {
    status,
    lastCheck: new Date().toISOString(),
    pid: process.pid,
    intervalSeconds,
    mode,
    conflicts,
    stopAt,
  };

  fs.writeFileSync(statusPath, JSON.stringify(liveStatus, null, 2), 'utf-8');
}

export async function fetchRemoteMetadataWithDb(dbUrl: string): Promise<RemoteWorkflowMetadata[]> {
  const pgClient = pg as any;
  const ClientClass = pgClient.Client || pgClient.default?.Client || pgClient;
  const client = new ClientClass({
    connectionString: dbUrl,
    ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false'))
      ? false
      : { rejectUnauthorized: false }
  });

  try {
    await client.connect();

    const colsRes = await client.query(`
      SELECT column_name, table_schema
      FROM information_schema.columns 
      WHERE table_name = 'workflow_entity';
    `);

    if (colsRes.rows.length === 0) {
      throw new Error('workflow_entity table not found in database.');
    }

    const schema = colsRes.rows[0].table_schema;
    const cols = colsRes.rows.map((r: any) => r.column_name);

    let folderCol = '';
    if (cols.includes('parentFolderId')) {
      folderCol = 'parentFolderId';
    } else if (cols.includes('folderId')) {
      folderCol = 'folderId';
    } else {
      const found = cols.find((c: string) => c.toLowerCase().includes('folder'));
      if (found) {
        folderCol = found;
      }
    }

    if (!folderCol) {
      throw new Error('Could not find folder relation column in workflow_entity table.');
    }

    const queryStr = `SELECT id, name, "updatedAt", "${folderCol}" AS "parentFolderId", "isArchived" FROM "${schema}"."workflow_entity";`;
    const res = await client.query(queryStr);

    return res.rows.map((row: any) => ({
      id: String(row.id),
      name: String(row.name),
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
      parentFolderId: row.parentFolderId ? String(row.parentFolderId) : null,
      isArchived: !!row.isArchived,
    }));
  } finally {
    try {
      await client.end();
    } catch (e) {}
  }
}

function extractIdFromResponse(response: any): string | null {
  if (!response) return null;
  if (typeof response === 'object') {
    if (response.id) return String(response.id);
    if (response.workflowId) return String(response.workflowId);
    if (response.workflow && response.workflow.id) return String(response.workflow.id);
  }
  return null;
}

export function liveCommand(program: Command) {
  program
    .command('live')
    .description('Start live synchronization (auto-pull and auto-push) with conflict detection')
    .option('--interval <seconds>', 'sync interval in seconds')
    .option('--ttl <minutes>', 'Time-To-Live for the daemon in minutes (defaults to 60)', '60')
    .option('--stop', 'stop a running live sync daemon process')
    .option('--status', 'print the current live sync daemon status')
    .option('--foreground', 'run in the foreground instead of background daemon mode')
    .option('--child', 'internal flag used to indicate child process execution')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .option('--api-key <key>', 'override n8n REST API key')
    .option('--url <url>', 'override n8n instance URL')
    .option('--db-url <url>', 'override n8n PostgreSQL database connection URL')
    .option('--env <name>', 'override environment name on run')
    .action(async (options) => {
      let mcp: McpClient | null = null;
      let syncTimer: NodeJS.Timeout | null = null;
      let activeConflicts: LiveConflictEntry[] = [];
      let isChecking = false;

      try {
        const { mcpCommand, accessToken, config, repoRoot, localDir, dbUrl, apiKey, instanceUrl } = getConnectionInfo(options);
        if (!config || !repoRoot) {
          throw new Error('Project must be initialized. Run `n8ncli init` first.');
        }

        const projectId = config.projectId;
        const folderId = config.folderId;
        const localWorkflowsDir = path.join(repoRoot, localDir, 'workflows');
        const statusPath = path.join(repoRoot, localDir, 'config', 'live-status.json');

        // 1. Handle --status option
        if (options.status) {
          if (!fs.existsSync(statusPath)) {
            output.log('No live sync daemon status file found. Daemon is not running.');
            return;
          }
          try {
            const status: LiveStatusFile = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
            let isRunning = false;
            if (status.status === 'running' && status.pid) {
              try {
                process.kill(status.pid, 0);
                isRunning = true;
              } catch (e) {}
            }
            if (status.status === 'running' && !isRunning) {
              writeLiveStatus(repoRoot, localDir, 'stopped', status.intervalSeconds, status.mode, status.conflicts);
              status.status = 'stopped';
            }
            output.log(`Daemon Status: ${isRunning ? 'RUNNING' : 'STOPPED'}`);
            output.log(`  - PID: ${status.pid || 'N/A'}`);
            output.log(`  - Mode: ${status.mode || 'N/A'}`);
            output.log(`  - Interval: ${status.intervalSeconds || 'N/A'}s`);
            if (isRunning && status.stopAt) {
              output.log(`  - Stop At: ${status.stopAt}`);
            }
            output.log(`  - Last Check: ${status.lastCheck || 'N/A'}`);
            output.log(`  - Conflicts: ${status.conflicts?.length || 0}`);
            if (status.conflicts && status.conflicts.length > 0) {
              output.error('Active Conflicts:');
              for (const c of status.conflicts) {
                output.error(`    - [${c.id}] ${c.name} (Path: ${c.localPath})`);
                output.error(`      Detected: ${c.detectedAt}`);
                output.error(`      Reason: ${c.reason}`);
              }
            }
          } catch (err) {
            output.error(`Failed to parse status file: ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }

        // 2. Handle --stop option
        if (options.stop) {
          if (!fs.existsSync(statusPath)) {
            output.log('No live sync daemon status file found. No running daemon detected.');
            return;
          }
          try {
            const status: LiveStatusFile = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
            if (status.pid) {
              let isRunning = false;
              try {
                process.kill(status.pid, 0);
                isRunning = true;
              } catch (e) {}
              if (isRunning) {
                output.log(`Stopping live sync daemon (PID: ${status.pid})...`);
                try {
                  process.kill(status.pid, 'SIGTERM');
                } catch (e) {
                  try {
                    process.kill(status.pid, 'SIGKILL');
                  } catch (ek) {}
                }
                writeLiveStatus(repoRoot, localDir, 'stopped', status.intervalSeconds, status.mode, status.conflicts);
                output.log('Daemon stopped.');
              } else {
                output.log('Daemon process is not active.');
                if (status.status === 'running') {
                  writeLiveStatus(repoRoot, localDir, 'stopped', status.intervalSeconds, status.mode, status.conflicts);
                }
              }
            } else {
              output.log('No PID found in status file.');
            }
          } catch (err) {
            output.error(`Failed to stop daemon: ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }

        // 3. Check if daemon is already running (prevent duplicate processes)
        let isAlreadyRunning = false;
        if (fs.existsSync(statusPath)) {
          try {
            const status: LiveStatusFile = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
            if (status.status === 'running' && status.pid) {
              try {
                process.kill(status.pid, 0);
                isAlreadyRunning = true;
              } catch (e) {}
            }
          } catch (e) {}
        }

        if (isAlreadyRunning && !options.child) {
          output.warn('Live sync daemon is already running. Run with --stop to terminate it first, or --status to inspect.');
          return;
        }

        // 4. Handle detached background spawning
        const runAsChild = options.child || process.env.N8N_LIVE_CHILD === 'true';
        const runInForeground = options.foreground || false;

        if (!runAsChild && !runInForeground) {
          const logPath = path.join(repoRoot, localDir, 'config', 'live-daemon.log');


          const originalArgs = process.argv.slice(2);
          const args = originalArgs.filter(arg => arg !== '--foreground');
          if (!args.includes('--child')) {
            args.push('--child');
          }

          const scriptFile = fs.existsSync(process.argv[1]) ? fs.realpathSync(process.argv[1]) : process.argv[1];
          const isTs = scriptFile.endsWith('.ts') || scriptFile.includes('cli.ts');
          const nodeArgs = [...process.execArgv];
          if (isTs && !nodeArgs.includes('tsx') && !nodeArgs.some(a => a.includes('tsx'))) {
            nodeArgs.push('--import', 'tsx');
          }

          const child = spawn(process.argv[0], [...nodeArgs, scriptFile, ...args], {
            detached: true,
            stdio: 'ignore',
            cwd: repoRoot,
            windowsHide: true,
            env: {
              ...process.env,
              N8N_LIVE_CHILD: 'true'
            }
          });

          child.unref();
          output.log(`Started live synchronization daemon in the background (PID: ${child.pid}).`);
          output.log(`  - Daemon logs redirected to: ${logPath}`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          return;
        }

        // If running as background child, redirect console output to log file
        if (runAsChild) {
          const logPath = path.join(repoRoot, localDir, 'config', 'live-daemon.log');
          const logDir = path.dirname(logPath);
          if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
          }
          const logStream = fs.createWriteStream(logPath, { flags: 'a' });
          console.log = (msg?: any, ...optionalParams: any[]) => {
            const formatMsg = optionalParams.length > 0 ? [msg, ...optionalParams].join(' ') : String(msg);
            logStream.write(`[${new Date().toISOString()}] ${formatMsg}\n`);
          };
          console.warn = console.log;
          console.error = (msg?: any, ...optionalParams: any[]) => {
            const formatMsg = optionalParams.length > 0 ? [msg, ...optionalParams].join(' ') : String(msg);
            logStream.write(`[${new Date().toISOString()}] [ERROR] ${formatMsg}\n`);
          };
        }

        // Determine Interval (Default 5s with DB, 20s with API)
        const isDbMode = !!dbUrl;
        const defaultInterval = isDbMode ? 5 : 20;
        const intervalSeconds = options.interval ? parseInt(options.interval, 10) : defaultInterval;

        // TTL settings
        let ttlMinutes = 60;
        if (options.ttl !== undefined) {
          const parsed = parseInt(options.ttl, 10);
          if (!isNaN(parsed)) {
            ttlMinutes = parsed;
          }
        }
        const startTime = Date.now();
        const ttlMs = ttlMinutes * 60 * 1000;
        const stopAt = new Date(startTime + ttlMs).toISOString();

        output.log(`Starting live synchronization daemon...`);
        output.log(`  - Environment: ${config.env || 'development'}`);
        output.log(`  - Project: ${config.projectName} (${projectId})`);
        output.log(`  - Interval: ${intervalSeconds} seconds`);
        output.log(`  - TTL: ${ttlMinutes} minutes`);
        output.log(`  - Stop At: ${stopAt}`);
        output.log(`  - Backend mode: ${isDbMode ? 'PostgreSQL Database + API' : 'REST API Only'}`);
        output.log(`  - Status file: ${statusPath}`);

        // Write initial live-status file
        writeLiveStatus(repoRoot, localDir, 'running', intervalSeconds, isDbMode ? 'db' : 'api', [], stopAt);

        // Initialize MCP client (keep connection open)
        mcp = new McpClient();
        await mcp.connect(mcpCommand, accessToken, instanceUrl);

        // Layout parameters
        const layoutConfig = (config as any).layout || {};
        const grid = layoutConfig.grid !== undefined ? layoutConfig.grid : 20;
        const nodesep = layoutConfig.nodesep !== undefined ? layoutConfig.nodesep : (2 * grid);
        const ranksep = layoutConfig.ranksep !== undefined ? layoutConfig.ranksep : (6 * grid);
        const alignTerminalNodes = layoutConfig.alignTerminalNodes !== undefined ? layoutConfig.alignTerminalNodes : true;
        const subnodeSep = layoutConfig.subnodeSep;
        const subnodeHorizontalSep = layoutConfig.subnodeHorizontalSep;
        const alignment = layoutConfig.alignment;

        // Clean shutdown handler
        const shutdown = async () => {
          output.log('\nStopping live synchronization daemon...');
          if (syncTimer) {
            clearTimeout(syncTimer);
          }
          if (mcp) {
            try {
              await mcp.disconnect();
            } catch (e) {}
          }
          try {
            writeLiveStatus(repoRoot, localDir, 'stopped', intervalSeconds, isDbMode ? 'db' : 'api', activeConflicts);
          } catch (e) {}
          output.log('Live daemon stopped successfully.');
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        // Core tick function
        const tick = async () => {
          if (isChecking) return;
          isChecking = true;

          try {
            // TTL Expiration Check
            if (Date.now() - startTime >= ttlMs) {
              output.log(`[LIVE] TTL of ${ttlMinutes} minutes reached. Terminating daemon.`);
              await shutdown();
              return;
            }

            // 1. Convert any legacy local JSON workflows
            convertLocalJsonWorkflows(localWorkflowsDir);

            // 2. Load sync state
            const syncState = loadSyncState(repoRoot, localDir);

            // 3. Scan local files
            const localFiles = glob.sync('**/*.workflow.ts', { cwd: localWorkflowsDir });
            const localRelativePaths: string[] = [];
            const localWorkflows: Record<string, { id: string; name: string; contentHash: string; code: string }> = {};

            for (const file of localFiles) {
              const relPath = file.replace(/\\/g, '/');
              const fullPath = path.join(localWorkflowsDir, file);
              try {
                let code = fs.readFileSync(fullPath, 'utf-8');

                // Auto-layout if layout changes exist
                const { code: updatedCode, laidOut } = await autoLayoutIfChanged(
                  fullPath,
                  code,
                  repoRoot,
                  path.join(localDir, 'workflows', relPath).replace(/\\/g, '/'),
                  {
                    nodesep,
                    ranksep,
                    grid,
                    alignTerminalNodes,
                    subnodeSep,
                    subnodeHorizontalSep,
                    alignment
                  }
                );
                if (laidOut) {
                  code = updatedCode;
                }

                const builder = parseWorkflowCodeToBuilder(code);
                const workflowJson = builder.toJSON();
                const wId = workflowJson.id || '';
                const wName = workflowJson.name || path.basename(relPath, '.workflow.ts');

                localWorkflows[relPath] = {
                  id: wId,
                  name: wName,
                  contentHash: calculateHash(code),
                  code,
                };
                localRelativePaths.push(relPath);
              } catch (e) {
                output.error(`[LIVE] Error parsing/laying out local file '${relPath}': ${e instanceof Error ? e.message : String(e)}`);
              }
            }

            // 4. Fetch remote folder structures (needed to target folder paths)
            let folderPaths: Record<string, string> = {};
            const folderPathToId: Record<string, string> = {};

            if (isDbMode) {
              try {
                const pgClient = pg as any;
                const ClientClass = pgClient.Client || pgClient.default?.Client || pgClient;
                const client = new ClientClass({
                  connectionString: dbUrl,
                  ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false'))
                    ? false
                    : { rejectUnauthorized: false }
                });
                await client.connect();
                const res = await client.query(
                  'SELECT id, name, "parentFolderId" FROM folder WHERE "projectId" = $1;',
                  [projectId]
                );
                await client.end();
                folderPaths = buildFolderPaths(res.rows, folderId);
                for (const [fId, fPath] of Object.entries(folderPaths)) {
                  folderPathToId[fPath.toLowerCase()] = fId;
                }
              } catch (e) {}
            } else {
              try {
                const foldersResponse = await mcp!.callToolAndGetJson('search_folders', { projectId });
                const folders = Array.isArray(foldersResponse) ? foldersResponse : (foldersResponse.folders || foldersResponse.data || []);
                folderPaths = buildFolderPaths(folders, folderId);
                for (const [fId, fPath] of Object.entries(folderPaths)) {
                  folderPathToId[fPath.toLowerCase()] = fId;
                }
              } catch (e) {}
            }

            // 5. Fetch remote workflows list
            let remoteWorkflows: RemoteWorkflowMetadata[] = [];
            if (isDbMode) {
              try {
                remoteWorkflows = await fetchRemoteMetadataWithDb(dbUrl);
              } catch (err) {
                // fallback to API on db failure
                const headers = { 'X-N8N-API-KEY': apiKey, 'Content-Type': 'application/json' };
                const workflows = await fetchWorkflowsPaginated(instanceUrl, projectId, headers);
                remoteWorkflows = workflows.map((w: any) => ({
                  id: String(w.id),
                  name: String(w.name),
                  updatedAt: String(w.updatedAt),
                  parentFolderId: w.parentFolderId || w.folderId || null,
                  isArchived: !!w.isArchived,
                }));
              }
            } else {
              const headers = { 'X-N8N-API-KEY': apiKey, 'Content-Type': 'application/json' };
              const workflows = await fetchWorkflowsPaginated(instanceUrl, projectId, headers);
              remoteWorkflows = workflows.map((w: any) => ({
                id: String(w.id),
                name: String(w.name),
                updatedAt: String(w.updatedAt),
                parentFolderId: w.parentFolderId || w.folderId || null,
                isArchived: !!w.isArchived,
              }));
            }

            // Filter remote workflows by folder scope
            const inScopeRemotes = remoteWorkflows.filter((rw) => {
              if (rw.isArchived) return false;
              const isInScope = !folderId || (rw.parentFolderId === folderId) || (rw.parentFolderId && folderPaths[rw.parentFolderId] !== undefined);
              return isInScope;
            });

            // Map representations
            const remoteMap = new Map<string, RemoteWorkflowMetadata>(inScopeRemotes.map(w => [w.id, w]));
            const localMap = new Map<string, { relPath: string; id: string; name: string; contentHash: string; code: string }>();
            for (const [relPath, lw] of Object.entries(localWorkflows)) {
              if (lw.id) {
                localMap.set(lw.id, { relPath, ...lw });
              }
            }

            // Keep track of active sync operations
            let pushedCount = 0;
            let pulledCount = 0;
            const currentConflictsMap = new Map<string, LiveConflictEntry>();

            // Process remote workflows (Pulls, updates, deletes)
            for (const rw of inScopeRemotes) {
              const stateEntry = Object.values(syncState.workflows).find(e => e.id === rw.id);

              if (!stateEntry) {
                // New Remote Workflow (untracked locally)
                if (!localMap.has(rw.id)) {
                  output.log(`[LIVE] Pulling new remote workflow: ${rw.name} (${rw.id})`);
                  try {
                    const details = await mcp!.callToolAndGetJson('get_workflow_details', { workflowId: rw.id, id: rw.id });
                    const detailsObj = details.workflow || details;
                    const tsCode = generateWorkflowCode(detailsObj);

                    const folderSubdir = rw.parentFolderId ? (folderPaths[rw.parentFolderId] || '') : '';
                    const sanitizeFilename = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_');
                    const filename = `${sanitizeFilename(detailsObj.name)}.workflow.ts`;
                    const relativePath = folderSubdir ? `${folderSubdir}/${filename}` : filename;
                    const fullPath = path.join(localWorkflowsDir, relativePath);

                    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                    fs.writeFileSync(fullPath, tsCode, 'utf-8');
                    saveWorkflowCache(repoRoot, rw.id, tsCode, localDir);

                    syncState.workflows[relativePath] = {
                      id: rw.id,
                      name: rw.name,
                      localPath: relativePath,
                      contentHash: calculateHash(tsCode),
                      remoteUpdatedAt: rw.updatedAt,
                      folderId: rw.parentFolderId || undefined,
                    };
                    pulledCount++;
                  } catch (err) {
                    output.error(`[LIVE] Failed to pull new workflow ${rw.name}: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
              } else {
                // Tracked workflow
                const localFileExists = fs.existsSync(path.join(localWorkflowsDir, stateEntry.localPath));

                if (!localFileExists) {
                  // File deleted locally -> Archive remote
                  output.log(`[LIVE] Local file deleted. Archiving remote workflow: ${rw.name} (${rw.id})`);
                  try {
                    await mcp!.callTool('archive_workflow', { workflowId: rw.id });
                    delete syncState.workflows[stateEntry.localPath];
                    deleteWorkflowCache(repoRoot, rw.id, localDir);
                  } catch (err) {
                    output.error(`[LIVE] Failed to archive workflow ${rw.name}: ${err instanceof Error ? err.message : String(err)}`);
                  }
                } else {
                  // Local file exists. Compare hashes and timestamps.
                  const lw = localWorkflows[stateEntry.localPath];
                  if (!lw) {
                    // Skip if local file failed to parse
                    continue;
                  }
                  const localHash = lw.contentHash;

                  const localChanged = stateEntry.contentHash !== localHash;
                  const remoteChanged = stateEntry.remoteUpdatedAt !== rw.updatedAt;

                  if (stateEntry.conflict) {
                    // Check if conflict resolved manually
                    if (localHash === calculateHash(generateWorkflowCode(await mcp!.callToolAndGetJson('get_workflow_details', { workflowId: rw.id, id: rw.id })))) {
                      output.log(`[LIVE] Conflict resolved manually for workflow: ${rw.name}. Resuming sync.`);
                      delete syncState.workflows[stateEntry.localPath].conflict;
                    } else {
                      // Keep conflict active
                      const prevConflict = activeConflicts.find(c => c.id === rw.id);
                      currentConflictsMap.set(rw.id, {
                        id: rw.id,
                        name: rw.name,
                        localPath: stateEntry.localPath,
                        detectedAt: prevConflict ? prevConflict.detectedAt : new Date().toISOString(),
                        reason: 'Modified both locally and remotely.'
                      });
                      continue;
                    }
                  }

                  if (localChanged && remoteChanged) {
                    // CONFLICT DETECTED
                    output.error(`[LIVE CONFLICT] Workflow '${rw.name}' modified both locally and remotely! Sync paused.`);
                    syncState.workflows[stateEntry.localPath].conflict = true;

                    const baseCode = loadWorkflowCache(repoRoot, rw.id, localDir);
                    const localCode = lw.code;
                    let remoteCode = '';
                    try {
                      const details = await mcp!.callToolAndGetJson('get_workflow_details', { workflowId: rw.id, id: rw.id });
                      remoteCode = generateWorkflowCode(details.workflow || details);
                    } catch (e) {}

                    if (baseCode && remoteCode) {
                      showConflictDiff(stateEntry.localPath, baseCode, localCode, remoteCode);
                    }

                    currentConflictsMap.set(rw.id, {
                      id: rw.id,
                      name: rw.name,
                      localPath: stateEntry.localPath,
                      detectedAt: new Date().toISOString(),
                      reason: 'Modified both locally and remotely.'
                    });
                  } else if (localChanged) {
                    // Only Local Changed -> Push
                    output.log(`[LIVE] Pushing local changes: ${stateEntry.localPath} (${rw.id})`);
                    try {
                      const builder = parseWorkflowCodeToBuilder(lw.code);
                      const workflowJson = builder.toJSON();

                      const allowedKeys = ['name', 'nodes', 'connections', 'settings', 'staticData', 'meta', 'pinData'];
                      const sanitizedWf: Record<string, any> = {};
                      for (const key of allowedKeys) {
                        if (workflowJson[key] !== undefined) {
                          sanitizedWf[key] = workflowJson[key];
                        }
                      }
                      if (sanitizedWf.settings) {
                        sanitizedWf.settings = { ...sanitizedWf.settings };
                        delete sanitizedWf.settings.availableInMCP;
                        delete sanitizedWf.settings.binaryMode;
                        delete sanitizedWf.settings.description;
                      }

                      const cleanInstanceUrl = instanceUrl.replace(/\/$/, '');
                      const res = await fetch(`${cleanInstanceUrl}/api/v1/workflows/${rw.id}`, {
                        method: 'PUT',
                        headers: {
                          'X-N8N-API-KEY': apiKey,
                          'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(sanitizedWf),
                      });

                      if (!res.ok) {
                        throw new Error(`REST API update failed: ${res.statusText}`);
                      }

                      // Fetch updated updatedAt
                      const details = await mcp!.callToolAndGetJson('get_workflow_details', { workflowId: rw.id, id: rw.id });
                      const updatedWf = details.workflow || details;

                      syncState.workflows[stateEntry.localPath] = {
                        ...stateEntry,
                        name: lw.name,
                        contentHash: localHash,
                        remoteUpdatedAt: updatedWf.updatedAt || new Date().toISOString(),
                      };
                      saveWorkflowCache(repoRoot, rw.id, lw.code, localDir);
                      pushedCount++;
                    } catch (err) {
                      output.error(`[LIVE] Failed to push workflow ${rw.name}: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  } else if (remoteChanged) {
                    // Only Remote Changed -> Pull
                    output.log(`[LIVE] Pulling remote changes: ${rw.name} (${rw.id})`);
                    try {
                      const details = await mcp!.callToolAndGetJson('get_workflow_details', { workflowId: rw.id, id: rw.id });
                      const detailsObj = details.workflow || details;
                      const tsCode = generateWorkflowCode(detailsObj);
                      const fullPath = path.join(localWorkflowsDir, stateEntry.localPath);

                      fs.writeFileSync(fullPath, tsCode, 'utf-8');
                      saveWorkflowCache(repoRoot, rw.id, tsCode, localDir);

                      syncState.workflows[stateEntry.localPath] = {
                        ...stateEntry,
                        contentHash: calculateHash(tsCode),
                        remoteUpdatedAt: rw.updatedAt,
                      };
                      pulledCount++;
                    } catch (err) {
                      output.error(`[LIVE] Failed to pull workflow ${rw.name}: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  }
                }
              }
            }

            // Handle new local workflows (untracked locally and remotely)
            for (const relPath of localRelativePaths) {
              const lw = localWorkflows[relPath];
              const alreadyTracked = Object.values(syncState.workflows).some(e => e.localPath === relPath || e.id === lw.id);

              if (!alreadyTracked && lw.code) {
                // Check if the id is already used remotely
                if (lw.id && remoteMap.has(lw.id)) {
                  // Re-associate local untracked file with existing remote ID
                  const rw = remoteMap.get(lw.id)!;
                  output.log(`[LIVE] Re-associating local file '${relPath}' with remote workflow '${rw.name}' (${rw.id})`);
                  syncState.workflows[relPath] = {
                    id: rw.id,
                    name: rw.name,
                    localPath: relPath,
                    contentHash: lw.contentHash,
                    remoteUpdatedAt: rw.updatedAt,
                    folderId: rw.parentFolderId || undefined,
                  };
                  saveWorkflowCache(repoRoot, rw.id, lw.code, localDir);
                } else {
                  // Brand new local file -> create remote workflow
                  output.log(`[LIVE] Creating remote workflow for new local file: ${relPath}`);
                  try {
                    const folderPart = path.dirname(relPath).replace(/\\/g, '/');
                    let targetFolderId = folderId;
                    if (folderPart && folderPart !== '.') {
                      const resolvedId = folderPathToId[folderPart.toLowerCase()];
                      if (resolvedId) {
                        targetFolderId = resolvedId;
                      }
                    }

                    const response = await mcp!.callTool('create_workflow_from_code', {
                      code: lw.code,
                      projectId,
                      folderId: targetFolderId,
                    });

                    let newId = extractIdFromResponse(response);
                    if (!newId) {
                      // fallback name search
                      try {
                        const searchResult = await mcp!.callToolAndGetJson('search_workflows', { projectId, limit: 200 });
                        const list = Array.isArray(searchResult) ? searchResult : (searchResult.data || searchResult.workflows || []);
                        const matched = list.find((w: any) => w.name === lw.name);
                        if (matched) newId = String(matched.id);
                      } catch (e) {}
                    }

                    if (newId) {
                      const details = await mcp!.callToolAndGetJson('get_workflow_details', { workflowId: newId, id: newId });
                      const detailsObj = details.workflow || details;

                      syncState.workflows[relPath] = {
                        id: newId,
                        name: lw.name,
                        localPath: relPath,
                        contentHash: lw.contentHash,
                        remoteUpdatedAt: detailsObj.updatedAt || new Date().toISOString(),
                        folderId: targetFolderId || undefined,
                      };
                      saveWorkflowCache(repoRoot, newId, lw.code, localDir);
                      pushedCount++;
                    } else {
                      throw new Error('Could not retrieve new workflow ID from creation.');
                    }
                  } catch (err) {
                    output.error(`[LIVE] Failed to create remote workflow for ${lw.name}: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
              }
            }

            // Handle remote-only deletions (tracked but no longer in remote list)
            for (const [relPath, entry] of Object.entries(syncState.workflows)) {
              if (!remoteMap.has(entry.id) && !entry.conflict) {
                // If it exists locally, delete it
                const fullPath = path.join(localWorkflowsDir, relPath);
                if (fs.existsSync(fullPath)) {
                  fs.unlinkSync(fullPath);
                  deleteWorkflowCache(repoRoot, entry.id, localDir);
                  output.log(`[LIVE] Deleted local file for deleted remote workflow: ${relPath}`);
                }
                delete syncState.workflows[relPath];
              }
            }

            // 6. Save sync state
            saveSyncState(repoRoot, syncState, localDir);

            // 7. Update status and list conflicts
            activeConflicts = Array.from(currentConflictsMap.values());
            writeLiveStatus(repoRoot, localDir, 'running', intervalSeconds, isDbMode ? 'db' : 'api', activeConflicts, stopAt);

            // 8. Log summary if changes occurred
            if (pushedCount > 0 || pulledCount > 0 || activeConflicts.length > 0) {
              output.log(`[LIVE] Sync cycle: ${pushedCount} pushed, ${pulledCount} pulled, ${activeConflicts.length} active conflicts.`);
            }
          } catch (tickErr) {
            output.error(`[LIVE] Error in sync loop tick: ${tickErr instanceof Error ? tickErr.message : String(tickErr)}`);
          } finally {
            isChecking = false;
            // Schedule next check
            syncTimer = setTimeout(tick, intervalSeconds * 1000);
          }
        };

        // Kick off sync
        await tick();
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        if (mcp) {
          try {
            await mcp.disconnect();
          } catch (e) {}
        }
        process.exit(1);
      }
    });
}
