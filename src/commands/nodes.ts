import { Command } from 'commander';
import { getConnectionInfo } from '../config.js';
import { withMcp } from '../mcp-client.js';
import * as output from '../output.js';

export function nodesCommand(program: Command) {
  const nodes = program
    .command('nodes')
    .description('Search nodes, discover parameter types, and get suggestions');

  nodes
    .command('search')
    .description('Search for n8n nodes by service name, trigger type, or utility')
    .argument('<queries...>', 'search queries (e.g., gmail, slack, if, merge)')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (queries, options) => {
      try {
        const { mcpCommand, accessToken } = getConnectionInfo(options);

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          const result = await mcp.callTool('search_nodes', {
            queries,
          });

          const text = result.content?.find((c: any) => c.type === 'text')?.text;
          output.log(text || 'No nodes found matching search queries.');
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  nodes
    .command('types')
    .description('Get TypeScript type definitions for n8n nodes')
    .argument('<nodeIds...>', 'node type IDs (e.g., n8n-nodes-base.gmail, n8n-nodes-base.slack)')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (nodeIds, options) => {
      try {
        const { mcpCommand, accessToken } = getConnectionInfo(options);

        const parsedNodeIds = nodeIds.map((id: string) => {
          if (id.includes(':')) {
            const [nodeId, resource, operation] = id.split(':');
            return { nodeId, resource, operation };
          }
          return { nodeId: id };
        });

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          const result = await mcp.callTool('get_node_types', {
            nodeIds: parsedNodeIds,
          });

          const text = result.content?.find((c: any) => c.type === 'text')?.text;
          output.log(text || 'No types returned.');
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  nodes
    .command('doc')
    .description('Get interactive documentation, SDK code examples, and parameters for a node')
    .argument('<nodeId>', 'node ID (e.g. n8n-nodes-base.gmailTrigger, or with resource/operation e.g. n8n-nodes-base.gmail:message:send)')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (nodeId, options) => {
      try {
        const { mcpCommand, accessToken } = getConnectionInfo(options);

        let resource: string | undefined;
        let operation: string | undefined;
        let cleanNodeId = nodeId;

        if (nodeId.includes(':')) {
          const parts = nodeId.split(':');
          cleanNodeId = parts[0];
          resource = parts[1];
          operation = parts[2];
        }

        output.log(`Fetching documentation for node '${nodeId}'...`);

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          const queryObj: any = { nodeId: cleanNodeId };
          if (resource) queryObj.resource = resource;
          if (operation) queryObj.operation = operation;

          const result = await mcp.callTool('get_node_types', {
            nodeIds: [queryObj]
          });

          const typeDefs = result.content?.find((c: any) => c.type === 'text')?.text;
          if (!typeDefs) {
            throw new Error(`No type definitions returned for node '${nodeId}'.`);
          }

          // Extract main parameters interface
          const interfaceMatch = typeDefs.match(/(?:interface|type)\s+(\w+Params)\s*(?:=)?\s*\{/);
          let properties: Array<{
            name: string;
            optional: boolean;
            type: string;
            description: string;
            defaultValue: string;
            builderHint: string;
          }> = [];

          if (interfaceMatch) {
            const startIdx = typeDefs.indexOf(interfaceMatch[0]) + interfaceMatch[0].length;
            let braceCount = 1;
            let endIdx = startIdx;
            while (braceCount > 0 && endIdx < typeDefs.length) {
              if (typeDefs[endIdx] === '{') braceCount++;
              else if (typeDefs[endIdx] === '}') braceCount--;
              endIdx++;
            }
            const interfaceBody = typeDefs.substring(startIdx, endIdx - 1);

            // Parse properties from body using a brace-depth tracking parser
            const lines = interfaceBody.split('\n');
            let depth = 0;
            let currentJSDoc: string[] = [];
            let inJSDoc = false;

            for (const line of lines) {
              const trimmed = line.trim();

              if (trimmed.startsWith('/**')) {
                inJSDoc = true;
                currentJSDoc = [line];
                if (trimmed.endsWith('*/')) {
                  inJSDoc = false;
                }
                continue;
              }

              if (inJSDoc) {
                currentJSDoc.push(line);
                if (trimmed.endsWith('*/')) {
                  inJSDoc = false;
                }
                continue;
              }

              let lineDepthChange = 0;
              for (const c of line) {
                if (c === '{') lineDepthChange++;
                else if (c === '}') lineDepthChange--;
              }

              if (depth === 0) {
                const match = trimmed.match(/^(\w+)\s*(\??)\s*:\s*(.+)/);
                if (match) {
                  const name = match[1];
                  const optional = match[2] === '?';
                  let type = match[3].trim();
                  if (type.endsWith(';')) {
                    type = type.substring(0, type.length - 1).trim();
                  }
                  if (type.endsWith('{')) {
                    type = 'object';
                  }

                  const jsdocRaw = currentJSDoc.join('\n');
                  let description = '';
                  let defaultValue = '';
                  let builderHint = '';

                  if (jsdocRaw) {
                    const jsdocLines = jsdocRaw.split('\n').map((l) => l.replace(/^\s*\/\*\*?/, '').replace(/\*\/$/, '').replace(/^\s*\*\s?/, '').trim());
                    const descLines = [];
                    for (const l of jsdocLines) {
                      if (l.startsWith('@default')) {
                        defaultValue = l.replace('@default', '').trim();
                      } else if (l.startsWith('@builderHint')) {
                        builderHint = l.replace('@builderHint', '').trim();
                      } else if (l.startsWith('@')) {
                        // ignore other tags
                      } else {
                        if (l) descLines.push(l);
                      }
                    }
                    description = descLines.join(' ');
                  }

                  properties.push({
                    name,
                    optional,
                    type,
                    description,
                    defaultValue,
                    builderHint
                  });

                  currentJSDoc = [];
                }
              }

              depth += lineDepthChange;

              if (trimmed && !inJSDoc && !trimmed.match(/^(\w+)\s*(\??)\s*:\s*([^;]+);/)) {
                if (trimmed !== '{' && trimmed !== '}' && trimmed !== '};' && trimmed !== '},') {
                  currentJSDoc = [];
                }
              }
            }
          }

          // Guess display name and variable name
          const baseName = cleanNodeId.split('.').pop() || cleanNodeId;
          const displayName = baseName.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase()).trim();
          const variableName = baseName.charAt(0).toLowerCase() + baseName.slice(1);

          // Version resolution
          const versionMatch = typeDefs.match(/version:\s*([0-9.]+);/i) || typeDefs.match(/version\s*=\s*([0-9.]+)/i) || typeDefs.match(/Version\s+([0-9.]+)/i);
          const version = versionMatch ? versionMatch[1] : '1';

          // Check if trigger
          const isTrigger = typeDefs.includes('isTrigger: true') || cleanNodeId.toLowerCase().includes('trigger');

          // Generate Code Example
          output.log(`\n## 📝 TypeScript SDK Usage Example\n`);
          
          let exampleParamsCode = '';
          if (resource) {
            exampleParamsCode += `        resource: '${resource}',\n`;
          }
          if (operation) {
            exampleParamsCode += `        operation: '${operation}',\n`;
          }

          for (const prop of properties) {
            if (prop.name === 'resource' || prop.name === 'operation') {
              continue;
            }
            let valStr = '...';
            if (prop.defaultValue) {
              valStr = prop.defaultValue;
            } else {
              const lowerType = prop.type.toLowerCase();
              if (lowerType.includes('boolean')) {
                valStr = 'true';
              } else if (lowerType.includes('number')) {
                valStr = '10';
              } else if (lowerType.includes('string')) {
                valStr = "'value'";
              } else if (lowerType.includes('array') || prop.type.includes('[]')) {
                valStr = '[]';
              } else if (lowerType.includes('{')) {
                valStr = '{}';
              }
            }

            let comment = `Type: ${prop.type}`;
            if (prop.builderHint) {
              comment += ` | Hint: ${prop.builderHint}`;
            }
            exampleParamsCode += `        ${prop.name}: ${valStr}, // ${comment}\n`;
          }

          const codeExample = `import { ${isTrigger ? 'trigger' : 'node'} } from '@workflows-accelerator/n8n-sdk';

const ${variableName} = ${isTrigger ? 'trigger' : 'node'}({
  type: '${cleanNodeId}',
  version: ${version},
  config: {
    name: '${displayName}',
    parameters: {
${exampleParamsCode.trimEnd()}
    }
  }
});`;

          console.log(`\`\`\`typescript\n${codeExample}\n\`\`\``);

          // Parameters Table
          if (properties.length > 0) {
            output.log(`\n## ⚙️ Parameters Summary Table\n`);
            
            console.log(`| Parameter | Type | Default | Builder Hint / Description |`);
            console.log(`| --- | --- | --- | --- |`);
            
            for (const prop of properties) {
               const nameCol = `**${prop.name}**${prop.optional ? ' (optional)' : ''}`;
               const typeCol = `\`${prop.type.replace(/\|/g, '\\|')}\``;
               const defaultCol = prop.defaultValue ? `\`${prop.defaultValue}\`` : '-';
               const descCol = prop.builderHint 
                 ? `💡 **Hint:** ${prop.builderHint}${prop.description ? ` <br> ${prop.description}` : ''}`
                 : prop.description || '-';
               
               console.log(`| ${nameCol} | ${typeCol} | ${defaultCol} | ${descCol} |`);
            }
          }

          // Raw Type Definitions
          output.log(`\n## 📄 Raw Type Definitions\n`);
          console.log(typeDefs);
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  nodes
    .command('suggest')
    .description('Curate recommended nodes for various categories')
    .argument('<categories...>', 'workflow technique categories (e.g. chatbot, scheduling, triage)')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (categories, options) => {
      try {
        const { mcpCommand, accessToken } = getConnectionInfo(options);

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          const result = await mcp.callTool('get_suggested_nodes', {
            categories,
          });

          const text = result.content?.find((c: any) => c.type === 'text')?.text;
          output.log(text || 'No suggestions returned.');
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

