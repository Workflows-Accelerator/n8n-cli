import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import pg from 'pg';
import { execSync } from 'child_process';
import { generateWorkflowCode, parseWorkflowCode } from '@n8n/workflow-sdk';
import { McpClient, withMcp } from './mcp-client.js';
import { N8nCliConfig, buildFolderPaths, getWorkflowDetails, loadGlobalConfig, ReferenceSource, fetchWorkflowsPaginated, fetchWorkflowsWithDb } from './config.js';
import * as output from './output.js';
import { glob } from 'glob';
import { calculateHash } from './sync-state.js';

export interface ReferenceWorkflowInfo {
  name: string;
  path: string;
  description: string;
}

export async function enableMcpForWorkflow(
  mcp: McpClient,
  instanceUrl: string,
  apiKey: string,
  w: any,
  enable: boolean,
  dbUrl?: string
) {
  // 1. Direct database update if dbUrl is configured
  if (dbUrl) {
    try {
      const pgModule = pg as any;
      const ClientClass = pgModule.Client || pgModule.default?.Client || pgModule;
      const client = new ClientClass({
        connectionString: dbUrl,
        ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false')) ? false : { rejectUnauthorized: false }
      });
      await client.connect();
      try {
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
        } catch (schemaErr) {
          // fallback to public
        }
        try {
          await client.query(
            `UPDATE "${schema}"."workflow_entity" SET "settings" = jsonb_set("settings"::jsonb, '{availableInMCP}', $1) WHERE "id" = $2;`,
            [enable ? 'true' : 'false', w.id]
          );
        } catch (dbErr) {
          // Fallback for text or older column types
          await client.query(
            `UPDATE "${schema}"."workflow_entity" SET "settings" = CAST(jsonb_set(CAST("settings" AS jsonb), '{availableInMCP}', $1) AS text) WHERE "id" = $2;`,
            [enable ? 'true' : 'false', w.id]
          );
        }
        output.log(`  [DB UPDATE] Successfully set availableInMCP: ${enable} for workflow ID ${w.id}`);
        return; // Success! Bypasses API/MCP updates
      } finally {
        await client.end();
      }
    } catch (dbErr) {
      output.warn(`Failed to update availableInMCP in database for workflow '${w.name || w.id}': ${dbErr instanceof Error ? dbErr.message : String(dbErr)}. Trying REST API fallback...`);
    }
  }

  // 2. Fallback: REST API PUT update (omits availableInMCP since n8n REST API rejects it)
  const fullWf = await getWorkflowDetails(mcp, instanceUrl, apiKey, w.id);
  const updatedSettings = { ...fullWf.settings, availableInMCP: enable };
  delete updatedSettings.binaryMode;

  const updatedWf = {
    ...fullWf,
    settings: updatedSettings,
  };

  if (apiKey && instanceUrl) {
    try {
      const allowedKeys = [
        'name',
        'nodes',
        'connections',
        'active',
        'settings',
        'staticData',
        'meta',
        'pinData',
        'versionId',
        'parentFolderId'
      ];
      const sanitizedWf: Record<string, any> = {};
      for (const key of allowedKeys) {
        if (updatedWf[key] !== undefined) {
          sanitizedWf[key] = updatedWf[key];
        }
      }

      // Remove availableInMCP from settings as n8n REST API PUT rejects it with 400 Bad Request
      if (sanitizedWf.settings) {
        sanitizedWf.settings = { ...sanitizedWf.settings };
        delete sanitizedWf.settings.availableInMCP;
      }

      const cleanInstanceUrl = instanceUrl.replace(/\/$/, '');
      const res = await fetch(`${cleanInstanceUrl}/api/v1/workflows/${w.id}`, {
        method: 'PUT',
        headers: {
          'X-N8N-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(sanitizedWf),
      });

      if (res.ok) {
        output.warn(`REST API update completed but n8n API does not support settings.availableInMCP. Please manually enable MCP access for '${w.name || w.id}' in n8n UI.`);
        return;
      }
      const errorText = await res.text();
      output.warn(`REST API update for workflow '${w.name || w.id}' returned status ${res.status}: ${res.statusText}. Error: ${errorText}. Falling back to MCP...`);
    } catch (apiErr) {
      output.warn(`REST API update for workflow '${w.name || w.id}' failed: ${apiErr instanceof Error ? apiErr.message : String(apiErr)}. Falling back to MCP...`);
    }
  }

  // 3. Fallback: Warn user to enable it manually and do a schema-compliant noop update via MCP
  output.warn(`Warning: Direct database connection is not available or failed. Cannot programmatically toggle availableInMCP to ${enable} for workflow '${w.name || w.id}'.`);
  output.warn(`Please enable "MCP access" manually in the n8n UI for this workflow, or configure N8N_DB_URL.`);

  try {
    await mcp.callTool('update_workflow', {
      workflowId: w.id,
      operations: [
        {
          type: 'setWorkflowMetadata',
        }
      ]
    });
  } catch (mcpErr) {
    output.warn(`MCP fallback update failed: ${mcpErr instanceof Error ? mcpErr.message : String(mcpErr)}`);
  }
}

export async function temporarilyEnableMcp(
  mcp: McpClient,
  instanceUrl: string,
  apiKey: string,
  projectId: string,
  folderId?: string,
  folderPaths: Record<string, string> = {},
  folderCache: Record<string, string | null> = {},
  dbUrl?: string
): Promise<Record<string, boolean>> {
  const headers = {
    'X-N8N-API-KEY': apiKey,
    'Content-Type': 'application/json',
  };
  
  const workflows = await fetchWorkflowsPaginated(instanceUrl, projectId, headers);

  const restoreMcpCache: Record<string, boolean> = {};
  for (const w of workflows) {
    if (w.isArchived) continue;

    const originalVal = w.settings?.availableInMCP ?? false;
    
    // Resolve folder from cache if available
    let wFolderId = folderCache[w.id];
    let isKnownScope = wFolderId !== undefined || !folderId;
    let isInScope = false;
    if (isKnownScope) {
      wFolderId = wFolderId || null;
      isInScope = !folderId || (wFolderId === folderId) || (wFolderId ? folderPaths[wFolderId] !== undefined : false);
    }

    if (isKnownScope) {
      if (isInScope) {
        if (!originalVal) {
          output.log(`Enabling MCP access permanently for in-scope workflow '${w.name}'...`);
          try {
            await enableMcpForWorkflow(mcp, instanceUrl, apiKey, w, true, dbUrl);
          } catch (e) {
            output.error(`Failed to enable MCP for workflow '${w.name}': ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } else {
        // Out of scope: do nothing!
      }
    } else {
      // Unknown scope: we must temporarily enable MCP, fetch details, check scope, and restore if out of scope
      if (!originalVal) {
        output.log(`Temporarily enabling MCP access for unknown scope workflow '${w.name}'...`);
        try {
          await enableMcpForWorkflow(mcp, instanceUrl, apiKey, w, true, dbUrl);
          
          const fullWf = await getWorkflowDetails(mcp, instanceUrl, apiKey, w.id);
          const resolvedFolderId = fullWf.parentFolderId || fullWf.folderId || null;
          const checkInScope = !folderId || (resolvedFolderId === folderId) || (resolvedFolderId && folderPaths[resolvedFolderId] !== undefined);
          
          if (!checkInScope) {
            restoreMcpCache[w.id] = false;
          }
        } catch (err) {
          output.error(`Failed to resolve scope for workflow '${w.name}': ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
  return restoreMcpCache;
}

export async function restoreMcpSettings(
  mcp: McpClient,
  instanceUrl: string,
  apiKey: string,
  projectId: string,
  mcpCache: Record<string, boolean>,
  folderId?: string,
  folderPaths: Record<string, string> = {},
  dbUrl?: string
) {
  for (const [wId, originalVal] of Object.entries(mcpCache)) {
    if (originalVal === false) {
      output.log(`Restoring MCP access to false for workflow ID: ${wId}...`);
      try {
        await enableMcpForWorkflow(mcp, instanceUrl, apiKey, { id: wId }, false, dbUrl);
      } catch (err) {
        output.error(`Failed to restore MCP for workflow ID ${wId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

function sanitizeDirName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').toLowerCase();
}

function getRepoName(repoUrl: string): string {
  const parts = repoUrl.split('/');
  let name = parts[parts.length - 1] || 'repo';
  if (name.endsWith('.git')) {
    name = name.slice(0, -4);
  }
  return name;
}

function runGitCommand(cmd: string, cwd: string): { success: boolean; error?: string } {
  try {
    execSync(cmd, { cwd, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf-8' });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.stderr || err.message };
  }
}

async function pullRemoteN8nReference(
  mcp: McpClient,
  config: N8nCliConfig,
  repoRoot: string,
  folderCache: Record<string, string | null>,
  instanceUrl: string,
  apiKey: string,
  dryRun: boolean,
  currentEnv: string | undefined,
  source: ReferenceSource,
  targetDir: string,
  subDir: string,
  activeRefPaths: Set<string>,
  workflowInfos: ReferenceWorkflowInfo[]
) {
  const refProjId = source.projectId!;
  const refFolderId = source.folderId;
  const refEnv = source.env || currentEnv || 'development';
  const isIndependentRefEnv = refEnv !== currentEnv;

  output.log(`Pulling remote references from project: ${source.projectName || refProjId} [Env: ${refEnv}]...`);

  const doPull = async (
    activeMcp: McpClient,
    activeInstanceUrl: string,
    activeApiKey: string,
    activeDbUrl: string,
    activeFolderCache: Record<string, string | null>
  ) => {
    let folderPaths: Record<string, string> = {};
    try {
      const foldersResponse = await activeMcp.callToolAndGetJson('search_folders', { projectId: refProjId });
      const folders = Array.isArray(foldersResponse) ? foldersResponse : (foldersResponse.folders || foldersResponse.data || []);
      folderPaths = buildFolderPaths(folders, refFolderId);
      
      if (!dryRun) {
        fs.mkdirSync(targetDir, { recursive: true });
        for (const subdir of Object.values(folderPaths)) {
          fs.mkdirSync(path.join(targetDir, subdir), { recursive: true });
        }
      }
    } catch (err) {
      output.warn(`Failed to fetch reference folders: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const response = await activeMcp.callToolAndGetJson('search_workflows', {
        projectId: refProjId,
        limit: 100,
      });

      const workflows = Array.isArray(response) ? response : (response.data || response.workflows || []);
      const availableWorkflows = workflows.filter((w: any) => w.availableInMCP === true);
      
      const sanitizeFilename = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_');

      for (const w of availableWorkflows) {
        if (w.isArchived) continue;
        try {
          const details = await getWorkflowDetails(activeMcp, activeInstanceUrl, activeApiKey, w.id);
          
          let wFolderId = activeFolderCache[w.id];
          if (wFolderId === undefined) {
            wFolderId = details.parentFolderId || details.folderId || null;
          }

          const isInScope = !refFolderId || (wFolderId === refFolderId) || (wFolderId && folderPaths[wFolderId] !== undefined);
          if (!isInScope) {
            continue;
          }

          const tsCode = generateWorkflowCode(details);
          const folderSubdir = wFolderId ? (folderPaths[wFolderId] || '') : '';
          const workflowTargetDir = folderSubdir ? path.join(targetDir, folderSubdir) : targetDir;
          const filename = `${sanitizeFilename(details.name)}.workflow.ts`;
          
          const relativeFilePath = subDir 
            ? (folderSubdir ? `${subDir}/${folderSubdir}/${filename}` : `${subDir}/${filename}`)
            : (folderSubdir ? `${folderSubdir}/${filename}` : filename);

          const fullPath = path.join(workflowTargetDir, filename);

          activeRefPaths.add(relativeFilePath.replace(/\\/g, '/'));

          const newHash = calculateHash(tsCode);
          const localExists = fs.existsSync(fullPath);
          const localContent = localExists ? fs.readFileSync(fullPath, 'utf-8') : '';
          const localHash = localExists ? calculateHash(localContent) : '';

          if (localExists && localHash === newHash) {
            // Unchanged
          } else {
            if (!localExists) {
              output.log(`  [CREATED] Reference: ${relativeFilePath}${dryRun ? ' (dry-run)' : ''}`);
            } else {
              output.log(`  [UPDATED] Reference: ${relativeFilePath}${dryRun ? ' (dry-run)' : ''}`);
            }
            if (!dryRun) {
              fs.mkdirSync(workflowTargetDir, { recursive: true });
              fs.writeFileSync(fullPath, tsCode, 'utf-8');
            }
          }

          let description = details.description || '';
          if (!description) {
            try {
              const parsed = parseWorkflowCode(tsCode) as any;
              description = parsed.description || '';
            } catch (e) {}
          }

          workflowInfos.push({
            name: details.name,
            path: relativeFilePath,
            description: description || 'No description provided.',
          });
        } catch (err) {
          output.warn(`Failed to pull reference workflow '${w.name}': ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      output.warn(`Failed to fetch reference workflows: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (!isIndependentRefEnv) {
    // Same environment: reuse active mcp
    // Temporarily enable MCP if it is a different project
    const isSameProject = refProjId === config.projectId;
    let refMcpCache: Record<string, boolean> = {};
    let refFolderPaths: Record<string, string> = {};

    try {
      if (!isSameProject) {
        try {
          const foldersResponse = await mcp.callToolAndGetJson('search_folders', { projectId: refProjId });
          const folders = Array.isArray(foldersResponse) ? foldersResponse : (foldersResponse.folders || foldersResponse.data || []);
          refFolderPaths = buildFolderPaths(folders, refFolderId);
        } catch (e) {}
        const dbUrl = process.env.N8N_DB_URL || loadGlobalConfig().environments?.[currentEnv || 'development']?.dbUrl || '';
        refMcpCache = await temporarilyEnableMcp(mcp, instanceUrl, apiKey, refProjId, refFolderId, refFolderPaths, folderCache, dbUrl);
      }

      const dbUrl = process.env.N8N_DB_URL || loadGlobalConfig().environments?.[currentEnv || 'development']?.dbUrl || '';
      await doPull(mcp, instanceUrl, apiKey, dbUrl, folderCache);
    } finally {
      if (!isSameProject) {
        output.log(`Restoring MCP access settings for reference project '${source.projectName || refProjId}'...`);
        try {
          const dbUrl = process.env.N8N_DB_URL || loadGlobalConfig().environments?.[currentEnv || 'development']?.dbUrl || '';
          await restoreMcpSettings(mcp, instanceUrl, apiKey, refProjId, refMcpCache, refFolderId, refFolderPaths, dbUrl);
        } catch (err) {
          output.error(`Failed to restore references project MCP settings: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } else {
    // Independent environment: resolve credentials and connect
    const globalConfig = loadGlobalConfig();
    const refEnvConfig = globalConfig.environments?.[refEnv] || {};
    const refMcpCommand = refEnvConfig.mcpCommand || globalConfig.mcpCommand || 'npx -y n8n-mcp';
    const refAccessToken = refEnvConfig.accessToken || globalConfig.accessToken || '';
    const refApiKey = refEnvConfig.apiKey || globalConfig.apiKey || '';
    const refInstanceUrl = refEnvConfig.instanceUrl || globalConfig.instanceUrl || '';
    const refDbUrl = refEnvConfig.dbUrl || globalConfig.dbUrl || '';

    if (!refAccessToken) {
      output.warn(`n8n access token is required for reference environment '${refEnv}'. Skipping.`);
      return;
    }
    if (!refInstanceUrl) {
      output.warn(`n8n instance URL is required for reference environment '${refEnv}'. Skipping.`);
      return;
    }

    // Retrieve reference-specific folder relationships from target DB
    let refFolderCache: Record<string, string | null> = {};
    if (refDbUrl) {
      try {
        output.log(`Fetching workflow-to-folder relationships for reference environment '${refEnv}' from PostgreSQL...`);
        const dbWorkflows = await fetchWorkflowsWithDb(refDbUrl);
        if (dbWorkflows) {
          for (const dbW of dbWorkflows) {
            refFolderCache[dbW.id] = dbW.parentFolderId || null;
          }
        }
      } catch (err) {
        output.warn(`Failed to retrieve folder cache from reference database for '${refEnv}': ${err instanceof Error ? err.message : String(err)}.`);
      }
    }

    output.log(`Connecting to reference environment '${refEnv}'...`);
    await withMcp(refMcpCommand, refAccessToken, async (refMcp) => {
      let refMcpCache: Record<string, boolean> = {};
      let refFolderPaths: Record<string, string> = {};
      try {
        try {
          const foldersResponse = await refMcp.callToolAndGetJson('search_folders', { projectId: refProjId });
          const folders = Array.isArray(foldersResponse) ? foldersResponse : (foldersResponse.folders || foldersResponse.data || []);
          refFolderPaths = buildFolderPaths(folders, refFolderId);
        } catch (e) {}
        refMcpCache = await temporarilyEnableMcp(refMcp, refInstanceUrl, refApiKey, refProjId, refFolderId, refFolderPaths, refFolderCache, refDbUrl);
        await doPull(refMcp, refInstanceUrl, refApiKey, refDbUrl, refFolderCache);
      } finally {
        output.log(`Restoring MCP access settings for reference project on environment '${refEnv}'...`);
        try {
          await restoreMcpSettings(refMcp, refInstanceUrl, refApiKey, refProjId, refMcpCache, refFolderId, refFolderPaths, refDbUrl);
        } catch (err) {
          output.error(`Failed to restore references project MCP settings on environment '${refEnv}': ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }, refInstanceUrl);
  }
}

async function pullLocalPathReference(
  repoRoot: string,
  source: ReferenceSource,
  targetDir: string,
  subDir: string,
  activeRefPaths: Set<string>,
  workflowInfos: ReferenceWorkflowInfo[],
  dryRun: boolean
) {
  const localSourcePath = path.isAbsolute(source.path!)
    ? source.path!
    : path.resolve(repoRoot, source.path!);

  output.log(`Resolving local references from directory: ${source.path}...`);

  if (!fs.existsSync(localSourcePath)) {
    output.warn(`Local reference directory not found: ${localSourcePath}`);
    return;
  }

  const files = glob.sync('**/*.{workflow.ts,json}', { cwd: localSourcePath, ignore: ['**/node_modules/**', '**/.git/**'] });

  for (const file of files) {
    const fullSourcePath = path.join(localSourcePath, file);
    try {
      const stat = fs.statSync(fullSourcePath);
      if (!stat.isFile()) continue;

      let tsCode = '';
      let workflowName = '';
      let description = '';

      if (file.endsWith('.workflow.ts')) {
        tsCode = fs.readFileSync(fullSourcePath, 'utf-8');
        try {
          const parsed = parseWorkflowCode(tsCode) as any;
          workflowName = parsed.name || path.basename(file, '.workflow.ts');
          description = parsed.description || '';
        } catch (e) {
          workflowName = path.basename(file, '.workflow.ts');
        }
      } else if (file.endsWith('.json') && file !== 'package.json' && file !== 'tsconfig.json') {
        const content = fs.readFileSync(fullSourcePath, 'utf-8');
        try {
          const parsed = JSON.parse(content);
          if (parsed && (Array.isArray(parsed.nodes) || parsed.connections)) {
            tsCode = generateWorkflowCode(parsed);
            workflowName = parsed.name || path.basename(file, '.json');
            description = parsed.description || '';
          } else {
            continue;
          }
        } catch (e) {
          continue;
        }
      } else {
        continue;
      }

      if (!tsCode) continue;

      const sanitizeFilename = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_');
      const filename = `${sanitizeFilename(workflowName)}.workflow.ts`;

      const fileDir = path.dirname(file);
      const relativeFilePath = subDir
        ? (fileDir !== '.' ? `${subDir}/${fileDir}/${filename}` : `${subDir}/${filename}`)
        : (fileDir !== '.' ? `${fileDir}/${filename}` : filename);

      const workflowTargetDir = fileDir !== '.' ? path.join(targetDir, fileDir) : targetDir;
      const fullDestPath = path.join(workflowTargetDir, filename);

      activeRefPaths.add(relativeFilePath.replace(/\\/g, '/'));

      const newHash = calculateHash(tsCode);
      const localExists = fs.existsSync(fullDestPath);
      const localContent = localExists ? fs.readFileSync(fullDestPath, 'utf-8') : '';
      const localHash = localExists ? calculateHash(localContent) : '';

      if (localExists && localHash === newHash) {
        // Unchanged
      } else {
        if (!localExists) {
          output.log(`  [CREATED] Reference: ${relativeFilePath}${dryRun ? ' (dry-run)' : ''}`);
        } else {
          output.log(`  [UPDATED] Reference: ${relativeFilePath}${dryRun ? ' (dry-run)' : ''}`);
        }
        if (!dryRun) {
          fs.mkdirSync(workflowTargetDir, { recursive: true });
          fs.writeFileSync(fullDestPath, tsCode, 'utf-8');
        }
      }

      workflowInfos.push({
        name: workflowName,
        path: relativeFilePath,
        description: description || 'No description provided.',
      });
    } catch (err) {
      output.warn(`Failed to process local reference file '${file}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function pullGitRepoReference(
  repoRoot: string,
  referencesDir: string,
  source: ReferenceSource,
  targetDir: string,
  subDir: string,
  activeRefPaths: Set<string>,
  workflowInfos: ReferenceWorkflowInfo[],
  dryRun: boolean
) {
  const repoUrl = source.repository!;
  const branch = source.branch;
  const repoName = getRepoName(repoUrl);
  
  const reposCacheDir = path.join(referencesDir, '.repos');
  const cloneDir = path.join(reposCacheDir, repoName);

  output.log(`Resolving references from Git repository: ${repoUrl}${branch ? ` [Branch: ${branch}]` : ''}...`);

  if (!dryRun) {
    fs.mkdirSync(reposCacheDir, { recursive: true });
  }

  let gitSuccess = false;
  if (fs.existsSync(cloneDir)) {
    output.log(`Updating cloned repository in ${path.relative(repoRoot, cloneDir)}...`);
    if (!dryRun) {
      const fetchRes = runGitCommand('git fetch', cloneDir);
      if (fetchRes.success) {
        const checkoutCmd = branch ? `git checkout ${branch}` : 'git checkout';
        const checkoutRes = runGitCommand(checkoutCmd, cloneDir);
        if (checkoutRes.success) {
          const pullRes = runGitCommand('git pull', cloneDir);
          if (pullRes.success) {
            gitSuccess = true;
          } else {
            output.warn(`Failed to git pull: ${pullRes.error}. Will attempt to use existing files.`);
            gitSuccess = true;
          }
        } else {
          output.warn(`Failed to git checkout branch ${branch || 'default'}: ${checkoutRes.error}. Will attempt to use existing files.`);
          gitSuccess = true;
        }
      } else {
        output.warn(`Failed to git fetch: ${fetchRes.error}. Will attempt to use existing files.`);
        gitSuccess = true;
      }
    } else {
      output.log(`(dry-run) Would update repository: git fetch && git checkout ${branch || ''} && git pull`);
      gitSuccess = true;
    }
  } else {
    output.log(`Cloning repository into ${path.relative(repoRoot, cloneDir)}...`);
    if (!dryRun) {
      const cloneCmd = branch ? `git clone -b ${branch} ${repoUrl} "${cloneDir}"` : `git clone ${repoUrl} "${cloneDir}"`;
      const cloneRes = runGitCommand(cloneCmd, repoRoot);
      if (cloneRes.success) {
        gitSuccess = true;
      } else {
        output.warn(`Failed to clone git repository: ${cloneRes.error}`);
      }
    } else {
      output.log(`(dry-run) Would clone repository: git clone ${repoUrl}`);
      gitSuccess = true;
    }
  }

  if (gitSuccess && fs.existsSync(cloneDir)) {
    const searchPath = source.path ? path.join(cloneDir, source.path) : cloneDir;
    const modifiedSource = { ...source, path: searchPath };
    await pullLocalPathReference(
      repoRoot,
      modifiedSource,
      targetDir,
      subDir,
      activeRefPaths,
      workflowInfos,
      dryRun
    );
  }
}

export async function pullReferences(
  mcp: McpClient,
  config: N8nCliConfig,
  repoRoot: string,
  folderCache: Record<string, string | null> = {},
  instanceUrl: string = '',
  apiKey: string = '',
  dryRun: boolean = false,
  currentEnv?: string
) {
  const rawReferences = config.references;
  if (!rawReferences) {
    output.debug('No reference sources configured. Skipping reference pull.');
    return;
  }

  const sources: ReferenceSource[] = Array.isArray(rawReferences)
    ? rawReferences
    : [rawReferences];

  if (sources.length === 0) {
    return;
  }

  const localDir = config.localDir || 'n8n';
  const referencesDir = path.join(repoRoot, localDir, 'references');
  if (!dryRun) {
    fs.mkdirSync(referencesDir, { recursive: true });
  } else {
    output.log(`(dry-run) Would ensure reference directory: ${path.join(localDir, 'references')}`);
  }

  const activeRefPaths = new Set<string>();
  const workflowInfos: ReferenceWorkflowInfo[] = [];

  const isLegacySingle = sources.length === 1 && !sources[0].name && !sources[0].path && !sources[0].repository;

  for (let idx = 0; idx < sources.length; idx++) {
    const source = sources[idx];
    let subDir = '';
    if (!isLegacySingle) {
      const rawName = source.name || source.projectName || (source.path ? path.basename(source.path) : '') || (source.repository ? getRepoName(source.repository) : '') || `source_${idx + 1}`;
      subDir = sanitizeDirName(rawName);
    }
    const targetDir = subDir ? path.join(referencesDir, subDir) : referencesDir;

    if (source.projectId) {
      await pullRemoteN8nReference(
        mcp,
        config,
        repoRoot,
        folderCache,
        instanceUrl,
        apiKey,
        dryRun,
        currentEnv,
        source,
        targetDir,
        subDir,
        activeRefPaths,
        workflowInfos
      );
    } else if (source.path) {
      await pullLocalPathReference(
        repoRoot,
        source,
        targetDir,
        subDir,
        activeRefPaths,
        workflowInfos,
        dryRun
      );
    } else if (source.repository) {
      await pullGitRepoReference(
        repoRoot,
        referencesDir,
        source,
        targetDir,
        subDir,
        activeRefPaths,
        workflowInfos,
        dryRun
      );
    }
  }

  // Clean up local reference files that are no longer in scope
  try {
    const localFiles = glob.sync('**/*.workflow.ts', { cwd: referencesDir, ignore: ['.repos/**'] });
    for (const localFile of localFiles) {
      const normalizedPath = localFile.replace(/\\/g, '/');
      if (!activeRefPaths.has(normalizedPath)) {
        const fullPath = path.join(referencesDir, normalizedPath);
        output.log(`  [DELETED] Reference: ${normalizedPath} (no longer in scope)${dryRun ? ' (dry-run)' : ''}`);
        if (!dryRun) {
          fs.unlinkSync(fullPath);

          // Clean up empty directories
          try {
            let dir = path.dirname(fullPath);
            while (dir !== referencesDir) {
              if (fs.readdirSync(dir).length === 0) {
                fs.rmdirSync(dir);
                dir = path.dirname(dir);
              } else {
                break;
              }
            }
          } catch (e) {
            // ignore
          }
        }
      }
    }
  } catch (e) {
    // ignore
  }

  // Write index.yaml
  const indexPath = path.join(referencesDir, 'index.yaml');
  const yamlContent = YAML.stringify({ workflows: workflowInfos });
  if (!dryRun) {
    fs.writeFileSync(
      indexPath,
      `# Auto-generated by n8ncli pull. Do not edit.\n# Read this file to find reference workflows, then read the .workflow.ts file for implementation details.\n\n${yamlContent}`,
      'utf-8'
    );
  }
  output.log(`Reference workflows synchronized. Index generated at: ${localDir}/references/index.yaml${dryRun ? ' (dry-run)' : ''}`);
}
