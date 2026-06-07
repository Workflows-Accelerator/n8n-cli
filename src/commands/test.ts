import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
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
        const { mcpCommand, accessToken, repoRoot, localDir } = getConnectionInfo(options);

        let workflowId = target;

        // Try to resolve from sync state if a file path is provided
        if (repoRoot) {
          const workflowsDir = path.join(repoRoot, localDir, 'workflows');
          const resolvedTarget = resolveAndConvertTarget(target, workflowsDir);
          const fullPath = path.resolve(resolvedTarget);
          if (fs.existsSync(fullPath)) {
            const relativePath = path.relative(workflowsDir, fullPath).replace(/\\/g, '/');
            const syncState = loadSyncState(repoRoot, localDir);
            const entry = syncState.workflows[relativePath];
            if (entry) {
              workflowId = entry.id;
              output.log(`Resolved local file '${relativePath}' to workflow ID: ${workflowId}`);
            } else {
              output.warn(`Local file '${relativePath}' is not tracked. Trying to use path as direct workflow ID.`);
            }
          }
        }

        let pinData: Record<string, any> = {};

        await withMcp(mcpCommand, accessToken, async (mcp) => {
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
              workflowId,
            });

            // Schemas can be an object describing node schemas
            const nodeSchemas = schemas.nodeSchemas || schemas;
            
            output.log('Auto-generating mock pin data from schemas...');
            for (const [nodeName, schema] of Object.entries(nodeSchemas)) {
              const mockValue = generateMockFromSchema(schema);
              // Wrap each item in {"json": ...} as required by test_workflow
              pinData[nodeName] = [{ json: mockValue }];
              output.debug(`Generated mock for node '${nodeName}': ${JSON.stringify(mockValue)}`);
            }
          }

          output.log(`Testing workflow ${workflowId} with pin data...`);

          const testResult = await mcp.callTool('test_workflow', {
            workflowId,
            pinData,
            triggerNodeName: options.trigger,
          });

          // Print test execution results
          const text = testResult.content?.find((c: any) => c.type === 'text')?.text;
          output.log(text || 'Test run succeeded.');
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
