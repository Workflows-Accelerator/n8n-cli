import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { parseWorkflowCodeToBuilder, generateWorkflowCode } from '@n8n/workflow-sdk';
import { getConnectionInfo, resolveAndConvertTarget } from '../config.js';
import { withMcp } from '../mcp-client.js';
import { loadSyncState } from '../sync-state.js';
import * as output from '../output.js';

function generateMockFromSchema(schema: any): any {
  if (!schema) return {};
  
  // Handle anyOf/allOf/oneOf
  if (schema.anyOf && schema.anyOf.length > 0) {
    return generateMockFromSchema(schema.anyOf[0]);
  }
  if (schema.oneOf && schema.oneOf.length > 0) {
    return generateMockFromSchema(schema.oneOf[0]);
  }
  if (schema.allOf && schema.allOf.length > 0) {
    return generateMockFromSchema(schema.allOf[0]);
  }

  if (schema.type === 'string') {
    if (schema.format === 'date-time') return new Date().toISOString();
    if (schema.format === 'email') return 'test@example.com';
    return 'mock-string';
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    return 0;
  }
  if (schema.type === 'boolean') {
    return false;
  }
  if (schema.type === 'array') {
    return [generateMockFromSchema(schema.items)];
  }
  if (schema.type === 'object' || schema.properties) {
    const obj: any = {};
    const props = schema.properties || {};
    for (const [key, prop] of Object.entries(props)) {
      obj[key] = generateMockFromSchema(prop);
    }
    return obj;
  }
  return {};
}

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

export function testCommand(program: Command) {
  program
    .command('test')
    .description('Run a local workflow test utilizing simulated pin data')
    .argument('<workflow-id-or-file>', 'workflow ID or local workflow file path')
    .option('--pin-data <file>', 'JSON file containing custom pin data')
    .option('--trigger <node-name>', 'trigger node name to start execution from')
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

        let pinData: Record<string, any> = {};

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          let runWfId = workflowId;
          let tempFolderId: string | undefined = undefined;
          let deployedTempWfId: string | null = null;

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
            // 3. Load / Auto-generate Pin Data
            if (options.pinData) {
              output.log(`Loading custom pin data from: ${options.pinData}...`);
              try {
                const fileContent = fs.readFileSync(options.pinData, 'utf-8');
                pinData = JSON.parse(fileContent);
              } catch (err) {
                throw new Error(`Failed to load pin data file: ${err instanceof Error ? err.message : String(err)}`);
              }
            } else {
              output.log('No pin data provided. Querying required pin data schema from n8n...');
              const schemas = await mcp.callToolAndGetJson('prepare_test_pin_data', {
                workflowId: runWfId,
              });

              const nodeSchemas = schemas.nodeSchemasToGenerate || schemas.nodeSchemas || schemas;

              output.log('Auto-generating mock pin data from schemas...');
              for (const [nodeName, schema] of Object.entries(nodeSchemas)) {
                const mockValue = generateMockFromSchema(schema);
                pinData[nodeName] = [{ json: mockValue }];
                output.debug(`Generated mock for node '${nodeName}': ${JSON.stringify(mockValue)}`);
              }
            }

            // 4. Run Test Execution
            output.log(`Testing workflow ${runWfId} with pin data...`);

            const testResult = await mcp.callTool('test_workflow', {
              workflowId: runWfId,
              pinData,
              triggerNodeName: options.trigger,
            });

            const text = testResult.content?.find((c: any) => c.type === 'text')?.text;
            output.log(text || 'Test run succeeded.');
          } finally {
            // 5. Cleanup Temporary Workflow & Folder
            if (dbUrl) {
              const pgClient = pg as any;
              const ClientClass = pgClient.Client || pgClient.default?.Client || pgClient;
              const client = new ClientClass({
                connectionString: dbUrl,
                ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false')) ? false : { rejectUnauthorized: false }
              });
              try {
                await client.connect();
                if (deployedTempWfId) {
                  output.log(`Deleting temporary execution data and workflow (${deployedTempWfId}) from DB...`);
                  await client.query('DELETE FROM execution_entity WHERE "workflowId" = $1;', [deployedTempWfId]);
                  await client.query('DELETE FROM shared_workflow WHERE "workflowId" = $1;', [deployedTempWfId]);
                  await client.query('DELETE FROM workflow_dependency WHERE "workflowId" = $1;', [deployedTempWfId]);
                  await client.query('DELETE FROM workflows_tags WHERE "workflowId" = $1;', [deployedTempWfId]);
                  await client.query('DELETE FROM workflow_entity WHERE id = $1;', [deployedTempWfId]);
                  output.log(`Successfully deleted temporary workflow from DB.`);
                }
                if (tempFolderId) {
                  // Check if any other non-deleted workflows are in this folder
                  const checkWfs = await client.query('SELECT id FROM workflow_entity WHERE "parentFolderId" = $1;', [tempFolderId]);
                  if (checkWfs.rows.length === 0) {
                    output.log(`Deleting temporary folder (${tempFolderId}) from DB...`);
                    await client.query('DELETE FROM folder WHERE id = $1;', [tempFolderId]);
                    output.log(`Successfully deleted temporary folder from DB.`);
                  }
                }
              } catch (dbCleanupErr) {
                output.debug(`DB cleanup failed: ${dbCleanupErr instanceof Error ? dbCleanupErr.message : String(dbCleanupErr)}. Falling back to MCP archiving.`);
                if (deployedTempWfId) {
                  try {
                    await mcp.callTool('archive_workflow', {
                      workflowId: deployedTempWfId,
                    });
                  } catch (cleanupErr) {
                    output.error(`Failed to cleanup temporary workflow: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
                  }
                }
              } finally {
                try { await client.end(); } catch (e) {}
              }
            } else {
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
          }
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
