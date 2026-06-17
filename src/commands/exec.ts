import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { parseWorkflowCodeToBuilder, generateWorkflowCode } from '@n8n/workflow-sdk';
import { getConnectionInfo, resolveAndConvertTarget } from '../config.js';
import { withMcp } from '../mcp-client.js';
import { loadSyncState } from '../sync-state.js';
import * as output from '../output.js';

async function findWorkflowIdByName(mcp: any, projectId: string, name: string): Promise<string | null> {
  try {
    const searchResult = await mcp.callToolAndGetJson('search_workflows', {
      projectId,
      limit: 200,
    });
    const list = Array.isArray(searchResult) ? searchResult : (searchResult.data || searchResult.workflows || []);
    const matched = list.find((w: any) => w.name === name);
    return matched ? String(matched.id) : null;
  } catch (err) {
    return null;
  }
}

function injectVirtualTriggerIfNeeded(json: any): { modified: boolean; code: string } {
  if (!json.nodes || !Array.isArray(json.nodes) || json.nodes.length === 0) {
    return { modified: false, code: '' };
  }

  // Check if there is already a trigger node
  const hasTrigger = json.nodes.some((node: any) => {
    const typeLower = (node.type || '').toLowerCase();
    return typeLower.endsWith('trigger') || typeLower.includes('manualtrigger') || typeLower.includes('webhook') || typeLower.includes('form') || typeLower.includes('onpublish');
  });

  if (hasTrigger) {
    return { modified: false, code: '' };
  }

  // Find nodes with no incoming connections
  const nodeNames = new Set(json.nodes.map((n: any) => n.name));
  const hasIncoming = new Set<string>();

  if (json.connections) {
    for (const fromNode of Object.keys(json.connections)) {
      const targetsObj = json.connections[fromNode];
      if (targetsObj) {
        for (const connectionType of Object.keys(targetsObj)) {
          const branches = targetsObj[connectionType];
          if (Array.isArray(branches)) {
            for (const branch of branches) {
              if (Array.isArray(branch)) {
                for (const conn of branch) {
                  if (conn && conn.node) {
                    hasIncoming.add(conn.node);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  const firstNodes: string[] = [];
  let firstNodePos = [100, 200];
  let foundPos = false;
  for (const node of json.nodes) {
    if (!hasIncoming.has(node.name)) {
      firstNodes.push(node.name);
      if (!foundPos && node.position && Array.isArray(node.position)) {
        firstNodePos = [node.position[0], node.position[1]];
        foundPos = true;
      }
    }
  }

  if (firstNodes.length === 0 && json.nodes.length > 0) {
    const fallbackNode = json.nodes[0];
    firstNodes.push(fallbackNode.name);
    if (fallbackNode.position && Array.isArray(fallbackNode.position)) {
      firstNodePos = [fallbackNode.position[0], fallbackNode.position[1]];
    }
  }

  const virtualTriggerName = 'Virtual Start';
  json.nodes.push({
    name: virtualTriggerName,
    type: 'n8n-nodes-base.manualTrigger',
    typeVersion: 1,
    position: [firstNodePos[0] - 200, firstNodePos[1]],
    parameters: {}
  });

  if (!json.connections) {
    json.connections = {};
  }
  json.connections[virtualTriggerName] = {
    main: [
      firstNodes.map(nodeName => ({
        node: nodeName,
        type: 'main',
        index: 0
      }))
    ]
  };

  output.log(`No trigger node found. Automatically injected '${virtualTriggerName}' connected to: ${firstNodes.join(', ')}`);
  
  return {
    modified: true,
    code: generateWorkflowCode(json)
  };
}

async function printFailedNodeDetails(mcp: any, workflowId: string, executionId: string) {
  try {
    output.log(`\nRetrieving failed node details for execution ${executionId}...`);
    const execution = await mcp.callToolAndGetJson('get_execution', {
      workflowId,
      executionId,
      includeData: true
    });

    if (execution && execution.data && execution.data.resultData && execution.data.resultData.runData) {
      const runData = execution.data.resultData.runData;
      let foundFailedNode = false;
      for (const [nodeName, runs] of Object.entries(runData)) {
        if (Array.isArray(runs)) {
          for (const run of runs) {
            if (run.error) {
              foundFailedNode = true;
              output.error(`\n❌ Node '${nodeName}' FAILED:`);
              output.error(`   Error Message: ${run.error.message || run.error.description || JSON.stringify(run.error)}`);
              if (run.error.stack) {
                output.error(`   Stack Trace:\n${run.error.stack}`);
              }
              if (run.data && run.data.main) {
                output.log(`   Node Input/Output Data:`);
                output.log(JSON.stringify(run.data.main, null, 2));
              }
            }
          }
        }
      }
      if (!foundFailedNode) {
        output.log(`No specific node errors found in execution runData.`);
      }
    }
  } catch (err) {
    output.debug(`Failed to retrieve detailed node execution error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function execCommand(program: Command) {
  program
    .command('exec')
    .description('Trigger execution of an n8n workflow')
    .argument('<workflow-id-or-file>', 'workflow ID or local workflow file path')
    .option('--mode <mode>', 'execution mode (production or manual)', 'production')
    .option('--input <json-or-file>', 'workflow input JSON string or file path')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (target, options) => {
      try {
        const { mcpCommand, accessToken, repoRoot, localDir, dbUrl, config } = getConnectionInfo(options);

        let workflowId = target;
        let isLocalFile = false;
        let localFullPath = '';
        let localRelativePath = '';
        let originalName = 'Workflow';
        let tempCode = '';

        // Try to resolve from sync state or local file if provided
        if (repoRoot) {
          const workflowsDir = path.join(repoRoot, localDir, 'workflows');
          const resolvedTarget = resolveAndConvertTarget(target, workflowsDir);
          localFullPath = path.resolve(resolvedTarget);
          if (fs.existsSync(localFullPath)) {
            isLocalFile = true;
            localRelativePath = path.relative(workflowsDir, localFullPath).replace(/\\/g, '/');
            const syncState = loadSyncState(repoRoot, localDir);
            const entry = syncState.workflows[localRelativePath];
            if (entry) {
              workflowId = entry.id;
            }

            try {
              const code = fs.readFileSync(localFullPath, 'utf-8');
              const builder = parseWorkflowCodeToBuilder(code);
              const json = builder.toJSON();
              originalName = json.name || 'Workflow';

              // Inject virtual manual trigger if no trigger node exists
              injectVirtualTriggerIfNeeded(json);
              
              // Generate random unique ID and prefix name to avoid conflicts
              const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
              let tempId = '';
              for (let i = 0; i < 16; i++) {
                tempId += chars.charAt(Math.floor(Math.random() * chars.length));
              }
              json.id = tempId;
              json.name = `[Temp Test] ${originalName}`;
              tempCode = generateWorkflowCode(json);
            } catch (err) {
              throw new Error(`Failed to parse local workflow file: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }

        // Parse inputs if provided
        let inputs: any = undefined;
        if (options.input) {
          try {
            if (fs.existsSync(options.input)) {
              inputs = JSON.parse(fs.readFileSync(options.input, 'utf-8'));
            } else {
              inputs = JSON.parse(options.input);
            }
          } catch (err) {
            throw new Error(`Failed to parse inputs JSON: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          let runWfId = workflowId;
          let tempFolderId: string | undefined = undefined;
          let deployedTempWfId: string | null = null;

          // If not a local file, check remote workflow for triggers
          if (!isLocalFile) {
            try {
              const details = await mcp.callToolAndGetJson('get_workflow_details', { workflowId: runWfId, id: runWfId });
              if (details) {
                const injection = injectVirtualTriggerIfNeeded(details);
                if (injection.modified) {
                  originalName = details.name || 'Workflow';
                  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                  let tempId = '';
                  for (let i = 0; i < 16; i++) {
                    tempId += chars.charAt(Math.floor(Math.random() * chars.length));
                  }
                  details.id = tempId;
                  details.name = `[Temp Test] ${originalName}`;
                  tempCode = generateWorkflowCode(details);
                  isLocalFile = true;
                }
              }
            } catch (err) {
              output.debug(`Failed to check remote workflow for triggers: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          if (isLocalFile && tempCode) {
            const projectId = config?.projectId;
            const parentFolderId = config?.folderId || null;

            // 1. Manage temporary folder in database if dbUrl is configured
            if (dbUrl && projectId) {
              const pgClient = pg as any;
              const ClientClass = pgClient.Client || pgClient.default?.Client || pgClient;
              const client = new ClientClass({
                connectionString: dbUrl,
                ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false')) ? false : { rejectUnauthorized: false }
              });
              try {
                await client.connect();
                const checkRes = await client.query(
                  'SELECT id FROM folder WHERE name = $1 AND "projectId" = $2 AND "parentFolderId" IS NOT DISTINCT FROM $3;',
                  ['[Temp Testing]', projectId, parentFolderId]
                );
                if (checkRes.rows.length > 0) {
                  tempFolderId = checkRes.rows[0].id;
                } else {
                  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                  let newId = '';
                  for (let i = 0; i < 16; i++) {
                    newId += chars.charAt(Math.floor(Math.random() * chars.length));
                  }
                  await client.query(
                    'INSERT INTO folder (id, name, "parentFolderId", "projectId", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, NOW(), NOW());',
                    [newId, '[Temp Testing]', parentFolderId, projectId]
                  );
                  tempFolderId = newId;
                  output.log(`Created temporary folder '[Temp Testing]' on remote (ID: ${tempFolderId})`);
                }
              } catch (dbErr) {
                output.warn(`Failed to manage temporary folder in DB: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}. Deploying directly instead.`);
              } finally {
                try { await client.end(); } catch (e) {}
              }
            }

            // 2. Deploy temporary workflow
            output.log(`Deploying temporary workflow for testing: '[Temp Test] ${originalName}'...`);
            try {
              const response = await mcp.callTool('create_workflow_from_code', {
                code: tempCode,
                projectId,
                folderId: tempFolderId || parentFolderId || undefined
              });

              // Extract ID from response
              const text = response.content?.find((c: any) => c.type === 'text')?.text || '';
              const match = text.match(/ID:\s*([a-zA-Z0-9_-]+)/i);
              if (match) {
                deployedTempWfId = match[1];
              } else {
                try {
                  const parsed = JSON.parse(text);
                  deployedTempWfId = parsed.id || parsed.workflowId || null;
                } catch (e) {}
              }

              if (!deployedTempWfId && projectId) {
                deployedTempWfId = await findWorkflowIdByName(mcp, projectId, `[Temp Test] ${originalName}`);
              }

              if (!deployedTempWfId) {
                throw new Error('Could not retrieve new workflow ID from creation response.');
              }

              runWfId = deployedTempWfId;
            } catch (err) {
              throw new Error(`Failed to deploy temporary workflow: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          try {
            // 3. Run Execution
            output.log(`Triggering execution of workflow ${runWfId} in ${options.mode} mode...`);

            const result = await mcp.callTool('execute_workflow', {
              workflowId: runWfId,
              executionMode: options.mode,
              inputs,
            });

            const text = result.content?.find((c: any) => c.type === 'text')?.text || '';
            output.log(text || 'Workflow executed successfully.');

            // Check if execution failed and print detailed error log
            if (text.toLowerCase().includes('fail') || text.toLowerCase().includes('error')) {
              const execIdMatch = text.match(/(?:execution\s*id|id):\s*([a-zA-Z0-9_-]+)/i);
              if (execIdMatch) {
                const executionId = execIdMatch[1];
                await printFailedNodeDetails(mcp, runWfId, executionId);
              }
            }
          } finally {
            // 4. Cleanup Temporary Workflow
            if (deployedTempWfId) {
              output.log(`Cleaning up temporary workflow (${deployedTempWfId})...`);
              try {
                await mcp.callTool('archive_workflow', {
                  workflowId: deployedTempWfId,
                });
              } catch (cleanupErr) {
                output.error(`Failed to cleanup temporary workflow: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
              }
            }
          }
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
