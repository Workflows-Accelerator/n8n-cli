import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { parseWorkflowCodeToBuilder, generateWorkflowCode } from '@n8n/workflow-sdk';
import { findRepoRoot, loadConfig, getConnectionInfo, getWorkflowDetails } from '../config.js';
import { withMcp } from '../mcp-client.js';
import { loadSyncState, isTargetScoped } from '../sync-state.js';
import * as output from '../output.js';

export interface InspectWorkflowOptions {
  target: string;
  node?: string;
  json?: boolean;
  mcpCommand?: string;
  accessToken?: string;
  apiKey?: string;
  instanceUrl?: string;
  env?: string;
  config?: string;
  fetchRemoteDetails?: (id: string) => Promise<any>;
}

export interface InspectNodeResult {
  name: string;
  type: string;
  typeVersion?: number;
  position?: [number, number];
  parameters?: Record<string, any>;
  notes?: string;
  notesInFlow?: boolean;
  disabled?: boolean;
}

export interface InspectWorkflowResult {
  id: string;
  name: string;
  active: boolean;
  source: 'local' | 'remote';
  filePath?: string;
  triggers: string[];
  nodes: InspectNodeResult[];
  connections: Record<string, any>;
  upstream: string[];
  downstream: string[];
  targetNode?: InspectNodeResult;
  tsCode: string;
}

export function extractNodeSnippetFromTs(fullCode: string, nodeName: string): string | null {
  const lines = fullCode.split('\n');
  let snippetLines: string[] = [];
  let inNodeBlock = false;
  let braceCount = 0;
  let parenCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inNodeBlock) {
      // Check if this line looks like the start of a trigger/node block
      const isStart = line.includes('trigger(') || line.includes('node(');
      if (isStart) {
        // Collect following lines until end of declaration to see if it matches nodeName
        let blockCandidate: string[] = [line];
        let bCount = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
        let pCount = (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
        let j = i;

        while (j + 1 < lines.length && (bCount > 0 || pCount > 0 || !blockCandidate.join('\n').includes(';'))) {
          j++;
          const nextLine = lines[j];
          blockCandidate.push(nextLine);
          bCount += (nextLine.match(/\{/g) || []).length - (nextLine.match(/\}/g) || []).length;
          pCount += (nextLine.match(/\(/g) || []).length - (nextLine.match(/\)/g) || []).length;
          if (bCount <= 0 && pCount <= 0 && nextLine.includes(';')) {
            break;
          }
        }

        const candidateText = blockCandidate.join('\n');
        // Check if candidateText contains name: '<nodeName>'
        const escaped = nodeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const nameRegex = new RegExp(`name:\\s*['"\`]${escaped}['"\`]`);
        if (nameRegex.test(candidateText)) {
          return candidateText.trim();
        }
      }
    }
  }

  return null;
}

export function generateSingleNodeSnippet(targetNode: InspectNodeResult, isTrigger = false): string {
  const safeName = targetNode.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const func = isTrigger ? 'trigger' : 'node';
  const nodeConfig: Record<string, any> = {
    name: targetNode.name,
  };
  if (targetNode.parameters && Object.keys(targetNode.parameters).length > 0) {
    nodeConfig.parameters = targetNode.parameters;
  }
  if (targetNode.position) {
    nodeConfig.position = targetNode.position;
  }
  if (targetNode.notes) {
    nodeConfig.notes = targetNode.notes;
    if (targetNode.notesInFlow !== undefined) {
      nodeConfig.notesInFlow = targetNode.notesInFlow;
    }
  }

  const rawJson = {
    nodes: [
      {
        name: targetNode.name,
        type: targetNode.type,
        typeVersion: targetNode.typeVersion || 1,
        position: targetNode.position || [0, 0],
        parameters: targetNode.parameters || {},
        notes: targetNode.notes,
        notesInFlow: targetNode.notesInFlow,
      }
    ],
    connections: {}
  };

  try {
    const fullTs = generateWorkflowCode(rawJson);
    const snippet = extractNodeSnippetFromTs(fullTs, targetNode.name);
    if (snippet) return snippet;
  } catch (e) {}

  return `const ${safeName} = ${func}({\n  type: '${targetNode.type}',\n  version: ${targetNode.typeVersion || 1},\n  config: ${JSON.stringify(nodeConfig, null, 2)}\n});`;
}

export function findConnectionsForNode(connections: Record<string, any>, nodeName: string): { upstream: string[]; downstream: string[] } {
  const downstream = new Set<string>();
  const upstream = new Set<string>();

  // Downstream: connections[nodeName] -> target nodes
  if (connections && connections[nodeName]) {
    for (const type of Object.keys(connections[nodeName])) {
      const outputs = connections[nodeName][type];
      if (Array.isArray(outputs)) {
        for (const outputList of outputs) {
          if (Array.isArray(outputList)) {
            for (const conn of outputList) {
              if (conn && conn.node) {
                downstream.add(conn.node);
              }
            }
          }
        }
      }
    }
  }

  // Upstream: any other sourceNode connecting to nodeName
  if (connections) {
    for (const [srcNode, types] of Object.entries(connections)) {
      if (types && typeof types === 'object') {
        for (const type of Object.keys(types)) {
          const outputs = types[type];
          if (Array.isArray(outputs)) {
            for (const outputList of outputs) {
              if (Array.isArray(outputList)) {
                for (const conn of outputList) {
                  if (conn && conn.node === nodeName) {
                    upstream.add(srcNode);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return {
    upstream: Array.from(upstream),
    downstream: Array.from(downstream),
  };
}

export function formatTopologyOutput(result: InspectWorkflowResult): string {
  const lines: string[] = [];
  lines.push(`Workflow: ${result.name} (ID: ${result.id || 'local'})`);
  lines.push(`Status:   ${result.active ? 'Active' : 'Inactive'} | Source: ${result.source}${result.filePath ? ` (${result.filePath})` : ''}`);
  if (result.triggers.length > 0) {
    lines.push(`Triggers: ${result.triggers.join(', ')}`);
  }
  lines.push('');
  lines.push(`Topology (${result.nodes.length} nodes):`);

  for (const n of result.nodes) {
    const isTrigger = result.triggers.includes(n.name);
    const nodeTag = isTrigger ? '[TRIGGER]' : '[NODE]';
    const conns = findConnectionsForNode(result.connections, n.name);
    const nextStr = conns.downstream.length > 0 ? ` -> [${conns.downstream.join(', ')}]` : '';
    lines.push(`  ${nodeTag} ${n.name} (${n.type} v${n.typeVersion || 1})${nextStr}`);

    // If node has parameters of interest (e.g. Code node jsCode or HTTP request url), provide a compact one-liner summary
    if (n.parameters) {
      if (typeof n.parameters.jsCode === 'string') {
        const firstCodeLine = n.parameters.jsCode.trim().split('\n')[0].substring(0, 70);
        lines.push(`         jsCode: ${firstCodeLine}${n.parameters.jsCode.length > 70 ? '...' : ''}`);
      } else if (typeof n.parameters.url === 'string') {
        lines.push(`         url: ${n.parameters.url}`);
      }
    }
  }

  return lines.join('\n');
}

export function formatNodeOutput(result: InspectWorkflowResult): string {
  const lines: string[] = [];
  const n = result.targetNode;
  if (!n) return '';

  lines.push(`Workflow: ${result.name} (ID: ${result.id || 'local'})`);
  lines.push(`Node:     ${n.name} (${n.type} v${n.typeVersion || 1})`);
  lines.push(`Upstream:   ${result.upstream.length > 0 ? result.upstream.join(', ') : '(none)'}`);
  lines.push(`Downstream: ${result.downstream.length > 0 ? result.downstream.join(', ') : '(none)'}`);
  lines.push('');
  lines.push('TypeScript SDK Declaration:');
  lines.push(result.tsCode);

  return lines.join('\n');
}

export async function inspectWorkflow(options: InspectWorkflowOptions): Promise<InspectWorkflowResult> {
  const target = options.target.trim();
  let fullTsCode = '';
  let workflowJson: any = null;
  let resolvedFilePath: string | undefined;
  let source: 'local' | 'remote' = 'local';

  // 1. Try local file resolution
  const directPath = path.resolve(target);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    resolvedFilePath = directPath;
    fullTsCode = fs.readFileSync(directPath, 'utf-8');
  } else {
    // Check inside repoRoot workflows directory
    const repoRoot = findRepoRoot();
    if (repoRoot) {
      let localDir = 'n8n';
      try {
        const config = loadConfig(repoRoot);
        localDir = config.localDir || 'n8n';
      } catch (e) {}

      const workflowsDir = path.join(repoRoot, localDir, 'workflows');
      if (fs.existsSync(workflowsDir)) {
        const candidateInWorkflows = path.join(workflowsDir, target);
        if (fs.existsSync(candidateInWorkflows) && fs.statSync(candidateInWorkflows).isFile()) {
          resolvedFilePath = candidateInWorkflows;
          fullTsCode = fs.readFileSync(candidateInWorkflows, 'utf-8');
        } else {
          // Check sync-state.json for matching workflow name or ID
          const syncState = loadSyncState(repoRoot, localDir);
          for (const [relPath, entry] of Object.entries(syncState.workflows)) {
            if (isTargetScoped(relPath, entry.id, entry.name, target)) {
              const fullMatch = path.join(workflowsDir, relPath);
              if (fs.existsSync(fullMatch)) {
                resolvedFilePath = fullMatch;
                fullTsCode = fs.readFileSync(fullMatch, 'utf-8');
                break;
              }
            }
          }

          // If still not matched, check glob *.workflow.ts
          if (!fullTsCode) {
            const allTsFiles = glob.sync('**/*.workflow.ts', { cwd: workflowsDir });
            for (const f of allTsFiles) {
              const fPath = path.join(workflowsDir, f);
              if (f.toLowerCase().includes(target.toLowerCase()) || path.basename(f, '.workflow.ts').toLowerCase() === target.toLowerCase()) {
                resolvedFilePath = fPath;
                fullTsCode = fs.readFileSync(fPath, 'utf-8');
                break;
              }
            }
          }
        }
      }
    }
  }

  // 2. If not found locally, fetch remotely in memory
  if (!fullTsCode) {
    source = 'remote';
    if (options.fetchRemoteDetails) {
      workflowJson = await options.fetchRemoteDetails(target);
    } else {
      const connInfo = getConnectionInfo(options);
      let fetched: any = null;
      let mcpConnected = false;

      try {
        await withMcp(connInfo.mcpCommand, connInfo.accessToken, async (mcp) => {
          mcpConnected = true;
          fetched = await getWorkflowDetails(mcp, connInfo.instanceUrl, connInfo.apiKey, target);
        });
      } catch (err) {
        if (!mcpConnected && connInfo.apiKey && connInfo.instanceUrl) {
          const dummyMcp = {
            callToolAndGetJson: async () => { throw new Error('MCP unavailable'); },
          };
          fetched = await getWorkflowDetails(dummyMcp, connInfo.instanceUrl, connInfo.apiKey, target);
        } else {
          throw err;
        }
      }

      if (!fetched) {
        throw new Error(`Workflow '${target}' could not be found locally or on remote n8n instance.`);
      }
      workflowJson = fetched;
    }

    fullTsCode = generateWorkflowCode(workflowJson);
  }

  // 3. Parse builder and get structured topology
  if (!workflowJson) {
    try {
      const builder = parseWorkflowCodeToBuilder(fullTsCode);
      workflowJson = builder.toJSON();
    } catch (parseErr) {
      // If parsing fullTsCode fails, attempt basic regex fallback
      throw new Error(`Failed to parse TypeScript workflow '${target}': ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
    }
  }

  const workflowId = workflowJson.id || '';
  const workflowName = workflowJson.name || (resolvedFilePath ? path.basename(resolvedFilePath, '.workflow.ts') : target);
  const active = !!workflowJson.active;
  const rawNodes: any[] = Array.isArray(workflowJson.nodes) ? workflowJson.nodes : [];
  const connections: Record<string, any> = workflowJson.connections || {};

  const triggers: string[] = [];
  const nodes: InspectNodeResult[] = [];

  for (const n of rawNodes) {
    const nodeName = n.name || '';
    const nodeType = n.type || '';
    const isTrigger = nodeType.toLowerCase().includes('trigger') || nodeType.toLowerCase().includes('webhook');
    if (isTrigger) {
      triggers.push(nodeName);
    }
    nodes.push({
      name: nodeName,
      type: nodeType,
      typeVersion: n.typeVersion,
      position: n.position,
      parameters: n.parameters,
      notes: n.notes,
      notesInFlow: n.notesInFlow,
      disabled: n.disabled,
    });
  }

  // 4. Handle --node scoping
  if (options.node) {
    const targetNodeName = options.node.trim();
    const foundNode = nodes.find(n => n.name.toLowerCase() === targetNodeName.toLowerCase());
    if (!foundNode) {
      const availableNames = nodes.map(n => `"${n.name}"`).join(', ');
      throw new Error(`Node "${targetNodeName}" not found in workflow "${workflowName}".\nAvailable nodes: ${availableNames}`);
    }

    const conns = findConnectionsForNode(connections, foundNode.name);
    const nodeSnippet = extractNodeSnippetFromTs(fullTsCode, foundNode.name) || generateSingleNodeSnippet(foundNode, triggers.includes(foundNode.name));

    return {
      id: workflowId,
      name: workflowName,
      active,
      source,
      filePath: resolvedFilePath,
      triggers,
      nodes,
      connections,
      upstream: conns.upstream,
      downstream: conns.downstream,
      targetNode: foundNode,
      tsCode: nodeSnippet,
    };
  }

  return {
    id: workflowId,
    name: workflowName,
    active,
    source,
    filePath: resolvedFilePath,
    triggers,
    nodes,
    connections,
    upstream: [],
    downstream: [],
    tsCode: fullTsCode,
  };
}

export function inspectCommand(program: Command) {
  program
    .command('inspect <target>')
    .description('Inspect workflow topology, single-node SDK declarations, or JSON tsCode')
    .option('--node <name>', 'extract node SDK block and edges')
    .option('--json', 'output structured JSON with topology and tsCode')
    .option('--api-key <key>', 'override n8n REST API key')
    .option('--url <url>', 'override n8n instance URL')
    .option('--env <name>', 'override environment name')
    .addHelpText('after', '\nExamples:\n  $ n8ncli inspect "Code Template"\n  $ n8ncli inspect demo.workflow.ts --node "Code Node"')
    .action(async (target, options) => {
      try {
        const result = await inspectWorkflow({
          target,
          node: options.node,
          json: options.json,
          mcpCommand: options.mcpCommand,
          accessToken: options.accessToken,
          apiKey: options.apiKey,
          instanceUrl: options.url,
          env: options.env,
        });

        if (options.json || output.getJsonMode()) {
          console.log(JSON.stringify({
            id: result.id,
            name: result.name,
            active: result.active,
            source: result.source,
            filePath: result.filePath,
            triggers: result.triggers,
            nodes: result.nodes,
            connections: result.connections,
            upstream: result.upstream,
            downstream: result.downstream,
            targetNode: result.targetNode,
            tsCode: result.tsCode,
          }, null, 2));
          return;
        }

        if (options.node) {
          console.log(formatNodeOutput(result));
        } else {
          console.log(formatTopologyOutput(result));
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
