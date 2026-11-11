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
  url?: string;
  env?: string;
  config?: string;
  fetchRemoteDetails?: (id: string) => Promise<any>;
}

export interface InspectNodeResult {
  name: string;
  type: string;
  typeVersion?: number;
  position?: [number, number];
  disabled?: boolean;
  notes?: string;
  notesInFlow?: boolean;
  downstream?: string[];
  summary?: string;
  parameters?: Record<string, any>;
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

export interface NodeConnectionBranch {
  type: string;
  index?: number;
  targets: string[];
}

export function summarizeNodeParameters(params?: Record<string, any>): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  if (typeof params.jsCode === 'string' && params.jsCode.trim().length > 0) {
    const trimmed = params.jsCode.trim();
    const firstLine = trimmed.split('\n')[0];
    const preview = firstLine.substring(0, 70);
    return `jsCode: ${preview}${firstLine.length > 70 || trimmed.includes('\n') ? '...' : ''}`;
  }
  if (typeof params.url === 'string' && params.url.trim().length > 0) {
    const url = params.url.trim();
    return `url: ${url.length > 80 ? url.substring(0, 80) + '...' : url}`;
  }
  return undefined;
}

export function findConnectionsForNode(connections: Record<string, any>, nodeName: string): {
  upstream: string[];
  downstream: string[];
  branches: NodeConnectionBranch[];
} {
  const downstream = new Set<string>();
  const upstream = new Set<string>();
  const branches: NodeConnectionBranch[] = [];

  // Downstream: connections[nodeName] -> target nodes
  if (connections && connections[nodeName]) {
    for (const [connType, outputs] of Object.entries(connections[nodeName])) {
      if (Array.isArray(outputs)) {
        if (connType === 'main') {
          if (outputs.length <= 1) {
            const targets: string[] = [];
            const list = outputs[0] || [];
            if (Array.isArray(list)) {
              for (const conn of list) {
                if (conn && conn.node) {
                  targets.push(conn.node);
                  downstream.add(conn.node);
                }
              }
            }
            if (targets.length > 0) {
              branches.push({ type: 'main', targets });
            }
          } else {
            outputs.forEach((branchList: any, idx: number) => {
              if (Array.isArray(branchList)) {
                const targets: string[] = [];
                for (const conn of branchList) {
                  if (conn && conn.node) {
                    targets.push(conn.node);
                    downstream.add(conn.node);
                  }
                }
                if (targets.length > 0) {
                  branches.push({ type: 'main', index: idx, targets });
                }
              }
            });
          }
        } else {
          const targets: string[] = [];
          for (const branchList of outputs) {
            if (Array.isArray(branchList)) {
              for (const conn of branchList) {
                if (conn && conn.node) {
                  targets.push(conn.node);
                  downstream.add(conn.node);
                }
              }
            }
          }
          if (targets.length > 0) {
            branches.push({ type: connType, targets });
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
    branches,
  };
}

export function extractNodeSnippetFromTs(fullCode: string, nodeName: string): string | null {
  let i = 0;
  const len = fullCode.length;
  let stmtStart = 0;
  let needStmtStart = true;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  const templateStack: number[] = [];
  let lastToken: { type: string; value: string } | null = null;

  function isWhitespace(ch: string): boolean {
    return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
  }

  function skipWhitespaceAndComments() {
    while (i < len) {
      const ch = fullCode[i];
      if (isWhitespace(ch)) {
        i++;
        continue;
      }
      if (ch === '/' && fullCode[i + 1] === '/') {
        i += 2;
        while (i < len && fullCode[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && fullCode[i + 1] === '*') {
        i += 2;
        while (i < len && !(fullCode[i] === '*' && fullCode[i + 1] === '/')) i++;
        if (i < len) i += 2;
        continue;
      }
      break;
    }
  }

  function readEscapeSequence(): string {
    // Assumes fullCode[i] === '\\'
    i++; // consume '\'
    if (i >= len) return '';
    const esc = fullCode[i];
    i++;
    if (esc === 'n') return '\n';
    if (esc === 'r') return '\r';
    if (esc === 't') return '\t';
    if (esc === 'x' && i + 2 <= len) {
      const hex = fullCode.substring(i, i + 2);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        i += 2;
        return String.fromCharCode(parseInt(hex, 16));
      }
    }
    if (esc === 'u') {
      if (fullCode[i] === '{') {
        const closeBrace = fullCode.indexOf('}', i + 1);
        if (closeBrace !== -1) {
          const hex = fullCode.substring(i + 1, closeBrace);
          if (/^[0-9a-fA-F]+$/.test(hex)) {
            i = closeBrace + 1;
            return String.fromCodePoint(parseInt(hex, 16));
          }
        }
      } else if (i + 4 <= len) {
        const hex = fullCode.substring(i, i + 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          i += 4;
          return String.fromCharCode(parseInt(hex, 16));
        }
      }
    }
    return esc;
  }

  function canStartRegex(tok: { type: string; value: string } | null): boolean {
    if (!tok) return true;
    if (tok.type === 'IDENT') {
      return ['return', 'throw', 'case', 'in', 'instanceof', 'typeof', 'void', 'delete', 'new', 'else', 'do', 'yield', 'await'].includes(tok.value);
    }
    if (tok.type === 'PUNCT') {
      return ![')', ']', '}', '++', '--'].includes(tok.value);
    }
    return false;
  }

  function readQuotedString(quote: string): string {
    i++; // consume opening quote
    let strVal = '';
    while (i < len && fullCode[i] !== quote) {
      if (fullCode[i] === '\\' && i + 1 < len) {
        strVal += readEscapeSequence();
      } else {
        strVal += fullCode[i];
        i++;
      }
    }
    if (i < len) i++; // consume closing quote
    return strVal;
  }

  function scanRegex() {
    i++; // consume opening '/'
    let inClass = false;
    while (i < len) {
      if (fullCode[i] === '\\' && i + 1 < len) {
        i += 2;
      } else if (fullCode[i] === '[' && !inClass) {
        inClass = true;
        i++;
      } else if (fullCode[i] === ']' && inClass) {
        inClass = false;
        i++;
      } else if (fullCode[i] === '/' && !inClass) {
        i++;
        break;
      } else if (fullCode[i] === '\n') {
        break;
      } else {
        i++;
      }
    }
    while (i < len && /[a-z]/i.test(fullCode[i])) i++;
  }

  function parseNodeCall(callStmtStart: number): string | null {
    i++; // consume '('
    let curParenDepth = 1;
    let curBraceDepth = 0;
    const braceKeyStack: Array<string | null> = [];
    const callTemplateStack: number[] = [];
    let isTarget = false;
    let lastKey: string | null = null;
    let lastCallToken: { type: string; value: string } | null = { type: 'PUNCT', value: '(' };

    while (i < len && curParenDepth > 0) {
      skipWhitespaceAndComments();
      if (i >= len) break;

      const ch = fullCode[i];

      // Quoted string
      if (ch === '\'' || ch === '"') {
        const strVal = readQuotedString(ch);
        const savedI = i;
        skipWhitespaceAndComments();
        if (fullCode[i] === ':' && curBraceDepth > 0) {
          lastKey = strVal;
          i++; // consume ':'
          lastCallToken = { type: 'PUNCT', value: ':' };
        } else {
          i = savedI;
          if (
            lastKey === 'name' &&
            (
              (braceKeyStack.length === 1 && braceKeyStack[0] === null) ||
              (braceKeyStack.length === 2 && braceKeyStack[0] === null && braceKeyStack[1] === 'config')
            )
          ) {
            if (strVal === nodeName) {
              isTarget = true;
            }
          }
          lastKey = null;
          lastCallToken = { type: 'STRING', value: strVal };
        }
        continue;
      }

      // Template literal
      if (ch === '`') {
        i++;
        let strVal = '';
        let hasInterp = false;
        while (i < len) {
          if (fullCode[i] === '\\' && i + 1 < len) {
            strVal += readEscapeSequence();
          } else if (fullCode[i] === '$' && fullCode[i + 1] === '{') {
            hasInterp = true;
            i += 2;
            curBraceDepth++;
            braceKeyStack.push('__template_expr__');
            callTemplateStack.push(curBraceDepth);
            break;
          } else if (fullCode[i] === '`') {
            i++;
            break;
          } else {
            strVal += fullCode[i];
            i++;
          }
        }
        if (
          !hasInterp &&
          lastKey === 'name' &&
          (
            (braceKeyStack.length === 1 && braceKeyStack[0] === null) ||
            (braceKeyStack.length === 2 && braceKeyStack[0] === null && braceKeyStack[1] === 'config')
          )
        ) {
          if (strVal === nodeName) {
            isTarget = true;
          }
        }
        lastKey = null;
        lastCallToken = { type: hasInterp ? 'PUNCT' : 'TEMPLATE', value: hasInterp ? '{' : strVal };
        continue;
      }

      // Closing template interpolation
      if (ch === '}' && callTemplateStack.length > 0 && curBraceDepth === callTemplateStack[callTemplateStack.length - 1]) {
        curBraceDepth--;
        braceKeyStack.pop();
        callTemplateStack.pop();
        i++; // consume '}'
        let ended = false;
        while (i < len) {
          if (fullCode[i] === '\\' && i + 1 < len) {
            readEscapeSequence();
          } else if (fullCode[i] === '$' && fullCode[i + 1] === '{') {
            i += 2;
            curBraceDepth++;
            braceKeyStack.push('__template_expr__');
            callTemplateStack.push(curBraceDepth);
            break;
          } else if (fullCode[i] === '`') {
            i++;
            ended = true;
            break;
          } else {
            i++;
          }
        }
        lastCallToken = { type: ended ? 'TEMPLATE' : 'PUNCT', value: ended ? '' : '{' };
        continue;
      }

      // Regex
      if (ch === '/' && fullCode[i + 1] !== '/' && fullCode[i + 1] !== '*' && canStartRegex(lastCallToken)) {
        scanRegex();
        lastCallToken = { type: 'REGEX', value: '' };
        lastKey = null;
        continue;
      }

      // Identifiers
      if (/[a-zA-Z_$]/.test(ch)) {
        const idStart = i;
        while (i < len && /[a-zA-Z0-9_$]/.test(fullCode[i])) i++;
        const ident = fullCode.substring(idStart, i);

        const savedI = i;
        skipWhitespaceAndComments();
        if (fullCode[i] === ':' && curBraceDepth > 0 && lastCallToken?.value !== '?') {
          lastKey = ident;
          i++; // consume ':'
          lastCallToken = { type: 'PUNCT', value: ':' };
        } else {
          i = savedI;
          lastCallToken = { type: 'IDENT', value: ident };
        }
        continue;
      }

      // Numbers
      if (/[0-9]/.test(ch)) {
        while (i < len && /[0-9a-fA-FxXoObBn._]/.test(fullCode[i])) i++;
        lastKey = null;
        lastCallToken = { type: 'NUMBER', value: '' };
        continue;
      }

      // Delimiters
      if (ch === '{') {
        curBraceDepth++;
        braceKeyStack.push(lastKey);
        lastKey = null;
        lastCallToken = { type: 'PUNCT', value: '{' };
        i++;
      } else if (ch === '}') {
        curBraceDepth--;
        braceKeyStack.pop();
        lastKey = null;
        lastCallToken = { type: 'PUNCT', value: '}' };
        i++;
      } else if (ch === '(') {
        curParenDepth++;
        lastKey = null;
        lastCallToken = { type: 'PUNCT', value: '(' };
        i++;
      } else if (ch === ')') {
        curParenDepth--;
        lastKey = null;
        lastCallToken = { type: 'PUNCT', value: ')' };
        i++;
      } else {
        if (ch === ',' || ch === ';' || ch === '[' || ch === ']') {
          lastKey = null;
        }
        lastCallToken = { type: 'PUNCT', value: ch };
        i++;
      }
    }

    let endIdx = i;
    const savedI = i;
    skipWhitespaceAndComments();
    if (fullCode[i] === ';') {
      i++;
      endIdx = i;
      lastToken = { type: 'PUNCT', value: ';' };
    } else {
      i = savedI;
      lastToken = { type: 'PUNCT', value: ')' };
    }
    needStmtStart = true;

    if (isTarget) {
      return fullCode.substring(callStmtStart, endIdx).trim();
    }
    return null;
  }

  while (i < len) {
    skipWhitespaceAndComments();
    if (i >= len) break;

    const tokenStart = i;
    const ch = fullCode[i];

    if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      if (needStmtStart || lastToken?.value === ';' || lastToken?.value === '}') {
        stmtStart = tokenStart;
        needStmtStart = false;
      }
    }

    if (ch === '\'' || ch === '"') {
      const val = readQuotedString(ch);
      lastToken = { type: 'STRING', value: val };
      continue;
    }

    if (ch === '`') {
      i++;
      let hasInterp = false;
      while (i < len) {
        if (fullCode[i] === '\\' && i + 1 < len) {
          readEscapeSequence();
        } else if (fullCode[i] === '$' && fullCode[i + 1] === '{') {
          hasInterp = true;
          i += 2;
          braceDepth++;
          templateStack.push(braceDepth);
          break;
        } else if (fullCode[i] === '`') {
          i++;
          break;
        } else {
          i++;
        }
      }
      lastToken = { type: hasInterp ? 'PUNCT' : 'TEMPLATE', value: hasInterp ? '{' : '' };
      continue;
    }

    if (ch === '}' && templateStack.length > 0 && braceDepth === templateStack[templateStack.length - 1]) {
      braceDepth--;
      templateStack.pop();
      i++;
      let ended = false;
      while (i < len) {
        if (fullCode[i] === '\\' && i + 1 < len) {
          readEscapeSequence();
        } else if (fullCode[i] === '$' && fullCode[i + 1] === '{') {
          i += 2;
          braceDepth++;
          templateStack.push(braceDepth);
          break;
        } else if (fullCode[i] === '`') {
          i++;
          ended = true;
          break;
        } else {
          i++;
        }
      }
      lastToken = { type: ended ? 'TEMPLATE' : 'PUNCT', value: ended ? '' : '{' };
      continue;
    }

    if (ch === '/' && fullCode[i + 1] !== '/' && fullCode[i + 1] !== '*' && canStartRegex(lastToken)) {
      scanRegex();
      lastToken = { type: 'REGEX', value: '' };
      continue;
    }

    if (/[a-zA-Z_$]/.test(ch)) {
      while (i < len && /[a-zA-Z0-9_$]/.test(fullCode[i])) i++;
      const ident = fullCode.substring(tokenStart, i);

      if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
        if (['const', 'let', 'var', 'export', 'import', 'function'].includes(ident)) {
          if (lastToken?.value !== 'export') {
            stmtStart = tokenStart;
          }
        }
      }

      const savedI = i;
      skipWhitespaceAndComments();
      if ((ident === 'node' || ident === 'trigger') && fullCode[i] === '(' && lastToken?.value !== '.') {
        const callStart = (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) ? stmtStart : tokenStart;
        const snippet = parseNodeCall(callStart);
        if (snippet) return snippet;
        continue;
      }
      i = savedI;
      lastToken = { type: 'IDENT', value: ident };
      continue;
    }

    if (/[0-9]/.test(ch)) {
      while (i < len && /[0-9a-fA-FxXoObBn._]/.test(fullCode[i])) i++;
      lastToken = { type: 'NUMBER', value: '' };
      continue;
    }

    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
    else if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth--;

    i++;
    lastToken = { type: 'PUNCT', value: ch };
    if (ch === ';') needStmtStart = true;
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
  if (targetNode.disabled !== undefined) {
    nodeConfig.disabled = targetNode.disabled;
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
        disabled: targetNode.disabled,
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
    const disabledTag = n.disabled ? ' [DISABLED]' : '';
    const conns = findConnectionsForNode(result.connections, n.name);

    let nextStr = '';
    if (conns.branches && conns.branches.length > 0) {
      if (conns.branches.length === 1 && conns.branches[0].type === 'main' && conns.branches[0].index === undefined) {
        nextStr = ` -> [${conns.branches[0].targets.join(', ')}]`;
      } else {
        const branchParts = conns.branches.map(b => {
          const label = b.index !== undefined ? `${b.type}[${b.index}]` : b.type;
          return `${label}: [${b.targets.join(', ')}]`;
        });
        nextStr = ` -> ${branchParts.join(' | ')}`;
      }
    }

    lines.push(`  ${nodeTag}${disabledTag} ${n.name} (${n.type} v${n.typeVersion || 1})${nextStr}`);

    if (n.summary) {
      lines.push(`         ${n.summary}`);
    } else if (n.parameters) {
      const summary = summarizeNodeParameters(n.parameters);
      if (summary) {
        lines.push(`         ${summary}`);
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
  lines.push(`Node:     ${n.name} (${n.type} v${n.typeVersion || 1})${n.disabled ? ' [DISABLED]' : ''}`);
  lines.push(`Upstream:   ${result.upstream.length > 0 ? result.upstream.join(', ') : '(none)'}`);
  lines.push(`Downstream: ${result.downstream.length > 0 ? result.downstream.join(', ') : '(none)'}`);
  lines.push('');
  lines.push('TypeScript SDK Declaration:');
  lines.push(result.tsCode);

  return lines.join('\n');
}

function loadLocalWorkflowFile(filePath: string): { tsCode: string; workflowJson: any } {
  const rawContent = fs.readFileSync(filePath, 'utf-8');
  const trimmed = rawContent.trim();
  const isJsonFile = filePath.toLowerCase().endsWith('.json') || trimmed.startsWith('{') || trimmed.startsWith('[');

  if (isJsonFile) {
    let parsed: any;
    try {
      parsed = JSON.parse(rawContent);
    } catch (err) {
      if (filePath.toLowerCase().endsWith('.json')) {
        throw new Error(`Failed to parse JSON workflow '${filePath}': ${err instanceof Error ? err.message : String(err)}`);
      }
      return { tsCode: rawContent, workflowJson: null };
    }

    let wfObj = parsed;
    if (Array.isArray(parsed) && parsed.length === 1 && parsed[0] && typeof parsed[0] === 'object') {
      wfObj = parsed[0];
    } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed.nodes) && parsed.data && typeof parsed.data === 'object' && Array.isArray(parsed.data.nodes)) {
      wfObj = parsed.data;
    }

    if (wfObj && typeof wfObj === 'object' && (Array.isArray(wfObj.nodes) || wfObj.connections)) {
      const tsCode = generateWorkflowCode(wfObj);
      return { tsCode, workflowJson: wfObj };
    }

    if (filePath.toLowerCase().endsWith('.json')) {
      throw new Error(`File '${filePath}' is valid JSON but not an n8n workflow (missing 'nodes' array).`);
    }
  }

  return { tsCode: rawContent, workflowJson: null };
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
    const loaded = loadLocalWorkflowFile(directPath);
    fullTsCode = loaded.tsCode;
    workflowJson = loaded.workflowJson;
  } else {
    // Check inside repoRoot workflows directory
    let repoRoot = findRepoRoot();
    let localDir = 'n8n';

    if (options.config) {
      const configPath = path.resolve(options.config);
      if (!fs.existsSync(configPath)) {
        throw new Error(`Custom configuration file not found at ${configPath}`);
      }
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (cfg && cfg.localDir) {
          localDir = cfg.localDir;
        }
      } catch (err) {
        throw new Error(`Failed to read/parse custom configuration at ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (configPath.endsWith(path.join('config', 'n8n-cli.json'))) {
        const parentDir = path.dirname(path.dirname(configPath));
        if (path.basename(parentDir) === localDir) {
          repoRoot = path.dirname(parentDir);
        } else {
          repoRoot = parentDir;
        }
      } else {
        repoRoot = path.dirname(configPath);
      }
    } else if (repoRoot) {
      try {
        const config = loadConfig(repoRoot);
        localDir = config.localDir || 'n8n';
      } catch (e) {}
    }

    if (repoRoot) {
      let workflowsDir = path.join(repoRoot, localDir, 'workflows');
      if (options.config && !fs.existsSync(workflowsDir)) {
        const altDir = path.join(path.dirname(path.dirname(path.resolve(options.config))), 'workflows');
        if (fs.existsSync(altDir)) {
          workflowsDir = altDir;
        }
      }
      if (fs.existsSync(workflowsDir)) {
        const candidatePaths = [
          path.join(workflowsDir, target),
          path.join(workflowsDir, `${target}.workflow.ts`),
          path.join(workflowsDir, `${target}.json`),
        ];
        const directInWorkflows = candidatePaths.find(p => fs.existsSync(p) && fs.statSync(p).isFile());
        if (directInWorkflows) {
          resolvedFilePath = directInWorkflows;
          const loaded = loadLocalWorkflowFile(directInWorkflows);
          fullTsCode = loaded.tsCode;
          workflowJson = loaded.workflowJson;
        } else {
          // Check sync-state.json for matching workflow name or ID
          const syncState = loadSyncState(repoRoot, localDir);
          for (const [relPath, entry] of Object.entries(syncState.workflows)) {
            if (isTargetScoped(relPath, entry.id, entry.name, target)) {
              const fullMatch = path.join(workflowsDir, relPath);
              if (fs.existsSync(fullMatch) && fs.statSync(fullMatch).isFile()) {
                resolvedFilePath = fullMatch;
                const loaded = loadLocalWorkflowFile(fullMatch);
                fullTsCode = loaded.tsCode;
                workflowJson = loaded.workflowJson;
                break;
              }
            }
          }

          // If still not matched, check glob **/*.workflow.ts and **/*.json
          if (!fullTsCode) {
            const allTsFiles = glob.sync('**/*.workflow.ts', { cwd: workflowsDir });
            const allJsonFiles = glob.sync('**/*.json', { cwd: workflowsDir })
              .filter(f => path.basename(f) !== 'sync-state.json' && path.basename(f) !== 'workflow-folders.json');
            const allFiles = [...allTsFiles, ...allJsonFiles];
            const lowerTarget = target.toLowerCase();

            // Pass 1: exact match on relative path or basename without extension
            let matchedFile = allFiles.find(f => {
              const base = path.basename(f).replace(/\.(workflow\.ts|json)$/i, '').toLowerCase();
              return f.toLowerCase() === lowerTarget || base === lowerTarget;
            });

            // Pass 2: substring match fallback
            if (!matchedFile) {
              matchedFile = allFiles.find(f => f.toLowerCase().includes(lowerTarget));
            }

            if (matchedFile) {
              const fPath = path.join(workflowsDir, matchedFile);
              resolvedFilePath = fPath;
              const loaded = loadLocalWorkflowFile(fPath);
              fullTsCode = loaded.tsCode;
              workflowJson = loaded.workflowJson;
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
      const connInfo = getConnectionInfo({
        ...options,
        url: options.instanceUrl || options.url,
      });
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
      throw new Error(`Failed to parse TypeScript workflow '${target}': ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
    }
  }

  const workflowId = workflowJson.id || '';
  const defaultName = resolvedFilePath
    ? path.basename(resolvedFilePath).replace(/\.(workflow\.ts|json)$/i, '')
    : target;
  const workflowName = workflowJson.name || defaultName;
  const active = !!workflowJson.active;
  const rawNodes: any[] = Array.isArray(workflowJson.nodes) ? workflowJson.nodes : [];
  const connections: Record<string, any> = workflowJson.connections || {};

  const triggers: string[] = [];
  const nodes: InspectNodeResult[] = [];

  for (const n of rawNodes) {
    const nodeName = n.name || '';
    const nodeType = n.type || '';
    const lowerType = nodeType.toLowerCase();
    const isTrigger = lowerType.includes('trigger') || (lowerType.includes('webhook') && !lowerType.includes('respond'));
    if (isTrigger) {
      triggers.push(nodeName);
    }

    const conns = findConnectionsForNode(connections, nodeName);
    const summary = summarizeNodeParameters(n.parameters);

    const nodeMeta: InspectNodeResult = {
      name: nodeName,
      type: nodeType,
      typeVersion: n.typeVersion,
      position: n.position,
      disabled: n.disabled,
      notes: n.notes,
      notesInFlow: n.notesInFlow,
      downstream: conns.downstream,
    };
    if (summary) {
      nodeMeta.summary = summary;
    }
    nodes.push(nodeMeta);
  }

  // 4. Handle --node scoping
  if (options.node) {
    const targetNodeName = options.node.trim();
    const foundNode = nodes.find(n => n.name.toLowerCase() === targetNodeName.toLowerCase());
    if (!foundNode) {
      const availableNames = nodes.map(n => `"${n.name}"`).join(', ');
      throw new Error(`Node "${targetNodeName}" not found in workflow "${workflowName}".\nAvailable nodes: ${availableNames}`);
    }

    const foundRawNode = rawNodes.find(n => (n.name || '').toLowerCase() === targetNodeName.toLowerCase());
    const targetNodeWithParams: InspectNodeResult = {
      ...foundNode,
      parameters: foundRawNode?.parameters,
    };

    const conns = findConnectionsForNode(connections, foundNode.name);
    const nodeSnippet = extractNodeSnippetFromTs(fullTsCode, foundNode.name) || generateSingleNodeSnippet(targetNodeWithParams, triggers.includes(foundNode.name));

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
      targetNode: targetNodeWithParams,
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
    .action(async (target, options, cmd) => {
      const opts = (cmd && typeof cmd.optsWithGlobals === 'function') ? cmd.optsWithGlobals() : options;
      try {
        const result = await inspectWorkflow({
          target,
          node: opts.node,
          json: opts.json,
          mcpCommand: opts.mcpCommand,
          accessToken: opts.accessToken,
          apiKey: opts.apiKey,
          instanceUrl: opts.url,
          env: opts.env,
          config: opts.config,
        });

        if (opts.json || output.getJsonMode()) {
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

        if (opts.node) {
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
