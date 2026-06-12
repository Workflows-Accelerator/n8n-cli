import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import dagre from 'dagre';

const require = createRequire(import.meta.url);

export interface LayoutOptions {
  nodesep?: number;
  ranksep?: number;
  grid?: number;
  alignTerminalNodes?: boolean;
  subnodeSep?: number;
  subnodeHorizontalSep?: number;
}

export interface NodeMetadata {
  node_type: string;
  outputs: any[];
  is_trigger: boolean;
  is_ai_tool: boolean;
}

// Global cache for node metadata loaded from SQLite
export const dbMetadataCache = new Map<string, NodeMetadata>();
let dbLoaded = false;

/**
 * Dynamically locate nodes.db in the user's npm-cache (_npx) folder.
 */
function findNodesDb(): { dbPath: string; sqljsPath: string } | null {
  try {
    const isWindows = os.platform() === 'win32';
    let npmCacheDir = '';
    if (isWindows) {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      npmCacheDir = path.join(localAppData, 'npm-cache', '_npx');
    } else {
      npmCacheDir = path.join(os.homedir(), '.npm', '_npx');
    }

    if (!fs.existsSync(npmCacheDir)) return null;

    const subdirs = fs.readdirSync(npmCacheDir);
    for (const subdir of subdirs) {
      const fullSubdir = path.join(npmCacheDir, subdir);
      if (fs.statSync(fullSubdir).isDirectory()) {
        const dbPath = path.join(fullSubdir, 'node_modules', 'n8n-mcp', 'data', 'nodes.db');
        const sqljsPath = path.join(fullSubdir, 'node_modules', 'sql.js');
        if (fs.existsSync(dbPath) && fs.existsSync(sqljsPath)) {
          return { dbPath, sqljsPath };
        }
      }
    }
  } catch (e) {
    // Ignore errors
  }
  return null;
}

/**
 * Load SQLite nodes database if present.
 */
export async function loadNodesDatabase(): Promise<boolean> {
  if (dbLoaded) return true;
  const dbInfo = findNodesDb();
  if (!dbInfo) return false;

  try {
    const initSqlJs = require(dbInfo.sqljsPath);
    const SQL = await initSqlJs();
    const filebuffer = fs.readFileSync(dbInfo.dbPath);
    const db = new SQL.Database(filebuffer);

    const res = db.exec(`
      SELECT node_type, outputs, is_trigger, is_ai_tool 
      FROM nodes;
    `);

    if (res.length > 0) {
      const columns = res[0].columns;
      const values = res[0].values;
      for (const val of values) {
        const type = val[0] as string;
        let outputsArr: any[] = [];
        try {
          if (val[1]) {
            outputsArr = JSON.parse(val[1] as string);
          }
        } catch (e) {}
        
        dbMetadataCache.set(type, {
          node_type: type,
          outputs: outputsArr,
          is_trigger: val[2] === 1,
          is_ai_tool: val[3] === 1
        });
      }
      dbLoaded = true;
      return true;
    }
  } catch (err) {
    // Fail silently, fallback to heuristic
  }
  return false;
}

/**
 * Clean node type name to match SQLite format
 */
export function cleanNodeType(type: string): string {
  return type.replace(/^@n8n\/n8n-/, '').replace(/^n8n-/, '');
}

/**
 * Simple markdown text height estimator for sticky notes
 */
function estimateTextHeight(text: string | undefined, width: number): number {
  if (!text) return 0;
  const avgCharWidth = 7;
  const lineHeight = 18;
  const charsPerLine = Math.max(10, Math.floor(width / avgCharWidth));
  const lines = text.split('\n');
  let totalLines = 0;
  for (const line of lines) {
    totalLines += Math.max(1, Math.ceil(line.length / charsPerLine));
  }
  return totalLines * lineHeight + 24;
}

/**
 * Determines inputs and outputs of a node based on DB and connections.
 */
function getNodeInputsAndOutputs(
  node: any,
  connectedInputs: Set<string>,
  connectedOutputs: Set<string>
): { inputs: string[]; outputs: string[] } {
  const nodeType = node.type;
  const cleanType = cleanNodeType(nodeType);
  const dbEntry = dbMetadataCache.get(cleanType);

  let outputs: string[] = [];
  let inputs: string[] = [];

  // 1. Resolve outputs
  if (dbEntry && dbEntry.outputs) {
    outputs = dbEntry.outputs
      .map(o => (typeof o === 'string' ? o : o.type || 'main'))
      .filter(o => !o.startsWith('={{'));
  } else {
    // Fallback output heuristic
    if (nodeType.endsWith('Tool')) {
      outputs = ['ai_tool'];
    } else {
      outputs = ['main'];
    }
  }

  // 2. Resolve inputs
  const isTrigger = dbEntry ? dbEntry.is_trigger : (nodeType.endsWith('Trigger') || nodeType === 'n8n-nodes-base.webhook');
  const isAiSubnode = outputs.some(o => o.startsWith('ai_')) && !outputs.includes('main');

  if (nodeType === 'n8n-nodes-base.stickyNote') {
    inputs = [];
    outputs = [];
  } else if (isTrigger) {
    inputs = [];
  } else if (isAiSubnode) {
    const isHitlOrAgentTool = nodeType.toLowerCase().includes('hitl') || nodeType.toLowerCase().includes('agent');
    if (isHitlOrAgentTool) {
      inputs = ['ai_languageModel'];
    } else {
      inputs = [];
    }
  } else if (nodeType === 'n8n-nodes-base.merge') {
    const rawInputs = node.parameters?.numberInputs;
    const count = typeof rawInputs === 'number' ? rawInputs : 2;
    inputs = Array(count).fill('main');
  } else {
    // Check if it's an AI cluster (Chain/Agent)
    const isAiCluster = nodeType.toLowerCase().includes('chain') || nodeType.toLowerCase().includes('agent');
    if (isAiCluster) {
      inputs = ['main', 'ai_languageModel'];
    } else {
      inputs = ['main'];
    }
  }

  // 3. Dynamic adjustment from active connections
  for (const connInput of connectedInputs) {
    if (!inputs.includes(connInput)) {
      inputs.push(connInput);
    }
  }
  for (const connOutput of connectedOutputs) {
    if (!outputs.includes(connOutput)) {
      outputs.push(connOutput);
    }
  }

  return { inputs, outputs };
}

/**
 * Compute node sizes and size types.
 */
function computeNodeSizes(nodes: any[], connections: any): Map<string, { width: number; height: number; type: string; inputs: string[]; outputs: string[] }> {
  const result = new Map<string, { width: number; height: number; type: string; inputs: string[]; outputs: string[] }>();

  // Map of node name to active connections (inputs and outputs)
  const connectedInputsMap = new Map<string, Set<string>>();
  const connectedOutputsMap = new Map<string, Set<string>>();

  for (const node of nodes) {
    connectedInputsMap.set(node.name, new Set());
    connectedOutputsMap.set(node.name, new Set());
  }

  // Populate from active connections in workflow
  if (connections) {
    for (const [sourceName, outputsObj] of Object.entries(connections)) {
      const srcOutputs = outputsObj as Record<string, any[][]>;
      for (const [outputType, destGroups] of Object.entries(srcOutputs)) {
        if (!destGroups) continue;
        const sourceOutputsSet = connectedOutputsMap.get(sourceName);
        if (sourceOutputsSet) sourceOutputsSet.add(outputType);

        for (const group of destGroups) {
          if (!group) continue;
          for (const conn of group) {
            if (!conn || !conn.node) continue;
            const destInputsSet = connectedInputsMap.get(conn.node);
            if (destInputsSet && conn.type) destInputsSet.add(conn.type);
          }
        }
      }
    }
  }

  for (const node of nodes) {
    const { inputs, outputs } = getNodeInputsAndOutputs(
      node,
      connectedInputsMap.get(node.name) || new Set(),
      connectedOutputsMap.get(node.name) || new Set()
    );

    // Adjust outputs array based on the actual number of connected main output ports
    const nodeConns = connections[node.name];
    if (nodeConns && Array.isArray(nodeConns.main)) {
      const activePortsCount = nodeConns.main.length;
      const mainCount = outputs.filter(o => o === 'main').length;
      if (activePortsCount > mainCount) {
        const filteredOutputs = outputs.filter(o => o !== 'main');
        for (let i = 0; i < activePortsCount; i++) {
          filteredOutputs.push('main');
        }
        outputs.splice(0, outputs.length, ...filteredOutputs);
      }
    }

    const isDynamic = typeof inputs === 'string' || typeof outputs === 'string';
    const hasInputs = inputs.length > 0;
    const hasOutputs = outputs.length > 0;
    const hasMainInput = inputs.includes('main');
    const hasMainOutput = outputs.includes('main');
    const hasNonMainInput = inputs.some(i => i !== 'main');
    const hasNonMainOutput = outputs.some(o => o !== 'main');
    const hasMultipleMainInputs = inputs.filter(i => i === 'main').length > 1;
    const hasMultipleMainOutputs = outputs.filter(o => o === 'main').length > 1;

    const node_size_type = isDynamic ? 'dynamic_unsupported' :
           !hasInputs && !hasOutputs ? 'sticky_note' :
           !hasInputs && hasOutputs && hasNonMainOutput && !hasMainOutput ? 'ai_sub_node' :
           !hasInputs && hasOutputs ? 'trigger' :
           hasInputs && !hasOutputs ? 'end_node' :
           hasNonMainInput && !hasMainInput && hasNonMainOutput && !hasMainOutput ? 'ai_sub_cluster' :
           hasMultipleMainInputs || hasMultipleMainOutputs ? 'flex' :
           hasMainInput && hasMainOutput && hasNonMainInput ? 'ai_cluster' :
           hasMainInput ? 'normal' :
           'unknown';

    const GRID_SIZE = 16;
    const DEFAULT_NODE_WIDTH = GRID_SIZE * 6;  // 96px
    const DEFAULT_NODE_HEIGHT = GRID_SIZE * 6; // 96px

    let width = DEFAULT_NODE_WIDTH;
    let height = DEFAULT_NODE_HEIGHT;

    switch (node_size_type) {
      case 'ai_cluster':
        width = GRID_SIZE * 17; // 272px
        height = DEFAULT_NODE_HEIGHT;
        break;

      case 'ai_sub_cluster':
        width = GRID_SIZE * 17; // 272px
        height = GRID_SIZE * 5;  // 80px
        break;

      case 'ai_sub_node':
        width = GRID_SIZE * 5; // 80px
        height = GRID_SIZE * 5; // 80px
        break;

      case 'flex':
        width = DEFAULT_NODE_WIDTH;
        const maxVerticalHandles = Math.max(inputs.length, outputs.length, 1);
        height = DEFAULT_NODE_HEIGHT + Math.max(0, maxVerticalHandles - 2) * GRID_SIZE * 2;
        break;

      case 'sticky_note':
        const paramWidth = node.parameters?.width;
        const paramHeight = node.parameters?.height;
        if (typeof paramWidth === 'number' && typeof paramHeight === 'number') {
          width = paramWidth;
          height = paramHeight;
        } else {
          width = GRID_SIZE * 15; // 240px
          height = GRID_SIZE * 10; // 160px
        }
        break;
    }

    result.set(node.name, { width, height, type: node_size_type, inputs, outputs });
  }

  return result;
}

/**
 * Layout the workflow JSON.
 */
export async function layoutWorkflow(workflowJson: any, options: LayoutOptions = {}): Promise<any> {
  // Try to load sqlite nodes db
  await loadNodesDatabase();

  const nodes = workflowJson.nodes || [];
  const connections = workflowJson.connections || {};

  if (nodes.length === 0) return workflowJson;

  // 1. Determine sizes
  const nodeInfoMap = computeNodeSizes(nodes, connections);

  // Find subnodes for each parent
  const subnodesMap = new Map<string, string[]>(); // parentName -> childNames[]
  const childToParent = new Map<string, string>(); // childName -> parentName

  for (const node of nodes) {
    const info = nodeInfoMap.get(node.name);
    if (!info) continue;
    if (info.type === 'ai_sub_node' || info.type === 'ai_sub_cluster') {
      // Find parent from outgoing connections
      let parentName: string | null = null;
      const outputsObj = connections[node.name];
      if (outputsObj) {
        for (const destGroups of Object.values(outputsObj as Record<string, any[][]>)) {
          if (!destGroups) continue;
          for (const group of destGroups) {
            if (!group) continue;
            for (const conn of group) {
              if (conn && conn.node && nodeInfoMap.has(conn.node)) {
                parentName = conn.node;
                break;
              }
            }
            if (parentName) break;
          }
          if (parentName) break;
        }
      }

      if (parentName) {
        childToParent.set(node.name, parentName);
        if (!subnodesMap.has(parentName)) {
          subnodesMap.set(parentName, []);
        }
        subnodesMap.get(parentName)!.push(node.name);
      }
    }
  }

  // 2. Identify Sticky Note Intersections
  const stickyNotes = nodes.filter((n: any) => n.type === 'n8n-nodes-base.stickyNote');
  const functionalNodes = nodes.filter((n: any) => n.type !== 'n8n-nodes-base.stickyNote');

  const stickyNoteInclusions = new Map<string, string[]>(); // noteName -> functionalNodeNames[]
  for (const note of stickyNotes) {
    stickyNoteInclusions.set(note.name, []);
    const [noteX, noteY] = note.position || [0, 0];
    const info = nodeInfoMap.get(note.name)!;
    const noteW = info.width;
    const noteH = info.height;

    for (const fNode of functionalNodes) {
      const [fX, fY] = fNode.position || [0, 0];
      const fInfo = nodeInfoMap.get(fNode.name)!;
      const fW = fInfo.width;
      const fH = fInfo.height;

      // Check if functional node box intersects with sticky note box
      const intersectX = (fX >= noteX && fX <= noteX + noteW) || (fX + fW >= noteX && fX + fW <= noteX + noteW);
      const intersectY = (fY >= noteY && fY <= noteY + noteH) || (fY + fH >= noteY && fY + fH <= noteY + noteH);
      if (intersectX && intersectY) {
        stickyNoteInclusions.get(note.name)!.push(fNode.name);
      }
    }
  }

  // 3. Branch Detection (Connected Components)
  // Build adjacency list for functional nodes
  const adj = new Map<string, Set<string>>();
  for (const node of functionalNodes) {
    adj.set(node.name, new Set());
  }

  for (const [sourceName, outputsObj] of Object.entries(connections)) {
    const srcOutputs = outputsObj as Record<string, any[][]>;
    for (const destGroups of Object.values(srcOutputs)) {
      if (!destGroups) continue;
      for (const group of destGroups) {
        if (!group) continue;
        for (const conn of group) {
          if (conn && conn.node && adj.has(sourceName) && adj.has(conn.node)) {
            adj.get(sourceName)!.add(conn.node);
            adj.get(conn.node)!.add(sourceName);
          }
        }
      }
    }
  }

  // Find components
  const visited = new Set<string>();
  const branches: string[][] = [];

  for (const node of functionalNodes) {
    if (!visited.has(node.name)) {
      const component: string[] = [];
      const queue = [node.name];
      visited.add(node.name);

      while (queue.length > 0) {
        const curr = queue.shift()!;
        component.push(curr);
        const neighbors = adj.get(curr) || new Set();
        for (const next of neighbors) {
          if (!visited.has(next)) {
            visited.add(next);
            queue.push(next);
          }
        }
      }
      branches.push(component);
    }
  }

  // 4. Per-branch layout
  const newPositions = new Map<string, [number, number]>();
  const branchLayouts: Array<{
    nodes: string[];
    width: number;
    height: number;
    origCenter: [number, number];
    origMinX: number;
    origMinY: number;
    positions: Map<string, [number, number]>;
  }> = [];

  const nodeMap = new Map<string, any>();
  for (const node of nodes) {
    nodeMap.set(node.name, node);
  }

  for (const branch of branches) {
    const g = new dagre.graphlib.Graph();
    g.setGraph({
      rankdir: 'LR',
      nodesep: options.nodesep || 50,
      ranksep: options.ranksep || 100,
    });
    g.setDefaultEdgeLabel(() => ({}));

    // Add nodes
    for (const nodeName of branch) {
      if (childToParent.has(nodeName)) continue;
      const info = nodeInfoMap.get(nodeName)!;
      g.setNode(nodeName, { width: info.width, height: info.height });
    }

    // Add edges
    for (const sourceName of branch) {
      if (childToParent.has(sourceName)) continue;
      const outputsObj = connections[sourceName];
      if (outputsObj) {
        for (const destGroups of Object.values(outputsObj as Record<string, any[][]>)) {
          if (!destGroups) continue;
          for (const group of destGroups) {
            if (!group) continue;
            for (const conn of group) {
              if (conn && conn.node && branch.includes(conn.node) && !childToParent.has(conn.node)) {
                g.setEdge(sourceName, conn.node);
              }
            }
          }
        }
      }
    }

    dagre.layout(g);

    const branchPositions = new Map<string, [number, number]>();

    // 1. Get positions of main nodes from Dagre
    for (const nodeName of branch) {
      if (childToParent.has(nodeName)) continue;
      const val = g.node(nodeName);
      if (!val) continue;
      const x = val.x - val.width / 2;
      const y = val.y - val.height / 2;
      branchPositions.set(nodeName, [x, y]);
    }

    console.log("[SWAP ENGINE] Raw Dagre positions in branchPositions:");
    for (const [nodeName, pos] of branchPositions.entries()) {
      console.log(`  - ${nodeName.padEnd(45)}: [${pos[0]}, ${pos[1]}]`);
    }

    const getDownstreamNodes = (startNode: string, branchNodes: string[], parent: string): Set<string> => {
      const visited = new Set<string>();
      const q = [startNode];
      visited.add(startNode);
      while (q.length > 0) {
        const curr = q.shift()!;
        const outputsObj = connections[curr];
        if (outputsObj) {
          for (const destGroups of Object.values(outputsObj as Record<string, any[][]>)) {
            if (!destGroups) continue;
            for (const group of destGroups) {
              if (!group) continue;
              for (const conn of group) {
                if (conn && conn.node && branchNodes.includes(conn.node) && conn.node !== parent && !childToParent.has(conn.node)) {
                  if (!visited.has(conn.node)) {
                    visited.add(conn.node);
                    q.push(conn.node);
                  }
                }
              }
            }
          }
        }
      }
      return visited;
    };

    // Sort branch nodes by X coordinate (upstream first)
    const sortedBranchNodes = [...branch].sort((a, b) => {
      const posA = branchPositions.get(a) || [0, 0];
      const posB = branchPositions.get(b) || [0, 0];
      return posA[0] - posB[0];
    });

    // Post-process to align vertical ordering of targets with port index order (e.g. IF/Switch outputs)
    const nodesep = options.nodesep || 50;
    for (const nodeName of sortedBranchNodes) {
      if (childToParent.has(nodeName)) continue;
      const outputsObj = connections[nodeName];
      if (outputsObj && outputsObj.main) {
        const mainOutputs = outputsObj.main as any[][];
        const targetsInfo: Array<{ node: string; y: number; index: number }> = [];
        for (let i = 0; i < mainOutputs.length; i++) {
          const group = mainOutputs[i];
          if (group && group.length > 0) {
            const targetNode = group[0].node;
            if (branch.includes(targetNode) && !childToParent.has(targetNode) && branchPositions.has(targetNode)) {
              targetsInfo.push({
                node: targetNode,
                y: branchPositions.get(targetNode)![1],
                index: i
              });
            }
          }
        }

        if (targetsInfo.length > 1) {
          console.log(`[ALIGN ENGINE] "${nodeName}": Targets before alignment:`, JSON.stringify(targetsInfo));
          
          // Check if this is a split-merge bypass structure
          // A bypass structure exists if one target connects to another target in targetsInfo.
          let bypassSourceIdx = -1;
          let bypassTargetIdx = -1;
          const targetSubtrees = targetsInfo.map(t => getDownstreamNodes(t.node, branch, nodeName));

          for (let i = 0; i < targetsInfo.length; i++) {
            for (let j = 0; j < targetsInfo.length; j++) {
              if (i !== j) {
                // Does target i reach target j?
                if (targetSubtrees[i].has(targetsInfo[j].node)) {
                  bypassSourceIdx = i;
                  bypassTargetIdx = j;
                  break;
                }
              }
            }
            if (bypassSourceIdx !== -1) break;
          }

          let sortedY: number[] = [];
          if (bypassSourceIdx !== -1 && bypassTargetIdx !== -1) {
            const splitNodePos = branchPositions.get(nodeName)!;
            const splitY = splitNodePos[1];
            const sideInfo = nodeInfoMap.get(targetsInfo[bypassSourceIdx].node);
            const sideHeight = sideInfo?.height || 96;
            const grid = options.grid || 20;
            const offset = Math.round((sideHeight + 4) / grid) * grid;
            
            const newY_merge = splitY;
            const newY_side = bypassSourceIdx < bypassTargetIdx ? splitY - offset : splitY + offset;
            
            sortedY = [];
            for (let idx = 0; idx < targetsInfo.length; idx++) {
              if (idx === bypassSourceIdx) {
                sortedY.push(newY_side);
              } else if (idx === bypassTargetIdx) {
                sortedY.push(newY_merge);
              } else {
                sortedY.push(splitY + (idx - bypassTargetIdx) * offset);
              }
            }
            console.log(`[ALIGN ENGINE] Bypass detected for "${nodeName}". Manual Y mapping:`, sortedY);
            // Since we manually mapped sortedY to ports, we must ensure targetsInfo is sorted by index
            targetsInfo.sort((a, b) => a.index - b.index);
          } else {
            // Sort target Y coordinates in ascending order
            const tempSortedY = targetsInfo.map(t => t.y).sort((a, b) => a - b);
            
            // Enforce equal separation between adjacent Y coordinates (height of previous node + nodesep)
            for (let idx = 1; idx < tempSortedY.length; idx++) {
              const prevTarget = targetsInfo[idx - 1];
              const prevInfo = nodeInfoMap.get(prevTarget.node);
              const minSep = (prevInfo?.height || 96) + nodesep;
              tempSortedY[idx] = tempSortedY[idx - 1] + minSep;
            }
            
            // Center the Y coordinates relative to the split node's vertical center
            const splitNodePos = branchPositions.get(nodeName)!;
            const splitInfo = nodeInfoMap.get(nodeName);
            const splitHeight = splitInfo?.height || 96;
            const targetCenterY = splitNodePos[1] + splitHeight / 2;

            let sumTargetCenterY = 0;
            for (let idx = 0; idx < targetsInfo.length; idx++) {
              const targetNode = targetsInfo[idx].node;
              const targetInfo = nodeInfoMap.get(targetNode);
              const targetHeight = targetInfo?.height || 96;
              sumTargetCenterY += tempSortedY[idx] + targetHeight / 2;
            }
            const avgCenter = sumTargetCenterY / targetsInfo.length;
            const diff = targetCenterY - avgCenter;

            for (let idx = 0; idx < tempSortedY.length; idx++) {
              tempSortedY[idx] += diff;
            }

            sortedY = tempSortedY;
            
            // Sort targets by index (port order)
            targetsInfo.sort((a, b) => a.index - b.index);
          }

          // Assign new Y positions and shift subtrees
          for (let i = 0; i < targetsInfo.length; i++) {
            const t = targetsInfo[i];
            const newY = sortedY[i];
            const diff = newY - t.y;
            console.log(`[ALIGN ENGINE] Target ${t.node} (idx ${t.index}): oldY = ${t.y}, newY = ${newY}, diff = ${diff}`);
            if (diff !== 0) {
              const subtree = targetSubtrees[i];
              
              // Find nodes unique to this subtree (not in other target subtrees)
              const uniqueSubtree = new Set<string>();
              for (const u of subtree) {
                let isShared = false;
                for (let j = 0; j < targetsInfo.length; j++) {
                  if (j !== i && targetSubtrees[j].has(u)) {
                    // Only count as shared if target i is not downstream of target j (merge-aware)
                    const targetIDownstreamOfJ = targetSubtrees[j].has(t.node);
                    if (!targetIDownstreamOfJ) {
                      isShared = true;
                      break;
                    }
                  }
                }
                if (!isShared) {
                  uniqueSubtree.add(u);
                }
              }

              // Shift unique nodes
              for (const u of uniqueSubtree) {
                const pos = branchPositions.get(u);
                if (pos) {
                  pos[1] += diff;
                  branchPositions.set(u, pos);
                }
              }
              t.y = newY;
            }
          }
        }
      }
    }



    // Align terminal/end nodes vertically with their closest predecessor in the branch
    if (options.alignTerminalNodes !== false) {
      for (const nodeName of branch) {
        if (childToParent.has(nodeName)) continue;
        
        const info = nodeInfoMap.get(nodeName);
        const isTerminal = info && (info.type === 'end_node' || !connections[nodeName] || Object.keys(connections[nodeName]).length === 0);
        
        if (isTerminal) {
          let bestPred: string | null = null;
          let maxPredX = -Infinity;
          
          for (const predName of branch) {
            if (predName === nodeName || childToParent.has(predName)) continue;
            const predOutputs = connections[predName];
            if (predOutputs) {
              let connectsToTerminal = false;
              for (const destGroups of Object.values(predOutputs as Record<string, any[][]>)) {
                if (!destGroups) continue;
                for (const group of destGroups) {
                  if (!group) continue;
                  for (const conn of group) {
                    if (conn && conn.node === nodeName) {
                      connectsToTerminal = true;
                      break;
                    }
                  }
                  if (connectsToTerminal) break;
                }
                if (connectsToTerminal) break;
              }
              
              if (connectsToTerminal) {
                const predPos = branchPositions.get(predName);
                if (predPos && predPos[0] > maxPredX) {
                  maxPredX = predPos[0];
                  bestPred = predName;
                }
              }
            }
          }
          
          if (bestPred && branchPositions.has(bestPred)) {
            const predInfo = nodeInfoMap.get(bestPred);
            const predOutputs = connections[bestPred];
            
            // Count total downstream targets of the predecessor
            let targetCount = 0;
            if (predOutputs) {
              for (const destGroups of Object.values(predOutputs as Record<string, any[][]>)) {
                if (!destGroups) continue;
                for (const group of destGroups) {
                  if (!group) continue;
                  for (const conn of group) {
                    if (conn && conn.node) {
                      targetCount++;
                    }
                  }
                }
              }
            }

            const isMultiOutput = predInfo && (predInfo.outputs.length > 1 || targetCount > 1);
            if (!isMultiOutput) {
              const terminalPos = branchPositions.get(nodeName)!;
              const predPos = branchPositions.get(bestPred)!;
              terminalPos[1] = predPos[1];
              branchPositions.set(nodeName, terminalPos);
            }
          }
        }
      }
    }

    // Backward propagation pass: align single-output nodes with their target (excluding bypass side-nodes)
    const sortedNodesReverse = [...branch].sort((a, b) => {
      const posA = branchPositions.get(a) || [0, 0];
      const posB = branchPositions.get(b) || [0, 0];
      return posB[0] - posA[0];
    });

    for (const nodeName of sortedNodesReverse) {
      if (childToParent.has(nodeName)) continue;
      const outputsObj = connections[nodeName];
      if (outputsObj) {
        const targets: string[] = [];
        for (const destGroups of Object.values(outputsObj as Record<string, any[][]>)) {
          if (!destGroups) continue;
          for (const group of destGroups) {
            if (!group) continue;
            for (const conn of group) {
              if (conn && conn.node && branch.includes(conn.node) && !childToParent.has(conn.node)) {
                if (!targets.includes(conn.node)) {
                  targets.push(conn.node);
                }
              }
            }
          }
        }

        if (targets.length === 1) {
          const targetName = targets[0];
          
          // Check if this node is a side-node in a split-merge bypass
          let isBypassSideNode = false;
          for (const pName of branch) {
            if (pName === nodeName || childToParent.has(pName)) continue;
            const pOutputs = connections[pName];
            let connectsToA = false;
            let connectsToB = false;
            if (pOutputs) {
              for (const dGroups of Object.values(pOutputs as Record<string, any[][]>)) {
                if (!dGroups) continue;
                for (const grp of dGroups) {
                  if (!grp) continue;
                  for (const c of grp) {
                    if (c && c.node === nodeName) connectsToA = true;
                    if (c && c.node === targetName) connectsToB = true;
                  }
                }
              }
            }
            if (connectsToA && connectsToB) {
              isBypassSideNode = true;
              break;
            }
          }

          if (!isBypassSideNode) {
            const targetPos = branchPositions.get(targetName);
            const targetInfo = nodeInfoMap.get(targetName);
            const currentInfo = nodeInfoMap.get(nodeName);
            if (targetPos && targetInfo && currentInfo) {
              const targetCenterY = targetPos[1] + targetInfo.height / 2;
              const newY = targetCenterY - currentInfo.height / 2;
              if (nodeName === 'Lock Thread' || nodeName === 'Get Thread') {
                console.log(`[BACKWARD LOG] ${nodeName}: target = ${targetName}, isBypassSideNode = ${isBypassSideNode}, targetCenterY = ${targetCenterY}, newY = ${newY}`);
              }
              const pos = branchPositions.get(nodeName);
              if (pos) {
                pos[1] = newY;
                branchPositions.set(nodeName, pos);
              }
            }
          }
        }
      }
    }

    // Centering pass for multi-output nodes (e.g. IF/Switch nodes)
    // Runs downstream-to-upstream (reverse X order) to ensure child split nodes are centered before parent split nodes
    for (const nodeName of sortedNodesReverse) {
      if (childToParent.has(nodeName)) continue;
      const outputsObj = connections[nodeName];
      if (outputsObj) {
        const targets: string[] = [];
        for (const destGroups of Object.values(outputsObj as Record<string, any[][]>)) {
          if (!destGroups) continue;
          for (const group of destGroups) {
            if (!group) continue;
            for (const conn of group) {
              if (conn && conn.node && branch.includes(conn.node) && !childToParent.has(conn.node)) {
                if (!targets.includes(conn.node)) {
                  targets.push(conn.node);
                }
              }
            }
          }
        }

        if (targets.length > 1) {
          // Calculate average center Y of targets
          let sumCenterY = 0;
          let validTargets = 0;
          for (const targetName of targets) {
            const targetPos = branchPositions.get(targetName);
            const targetInfo = nodeInfoMap.get(targetName);
            if (targetPos && targetInfo) {
              const targetCenterY = targetPos[1] + targetInfo.height / 2;
              sumCenterY += targetCenterY;
              validTargets++;
            }
          }

          if (validTargets > 0) {
            const avgCenterY = sumCenterY / validTargets;
            const currentInfo = nodeInfoMap.get(nodeName);
            const currentPos = branchPositions.get(nodeName);
            if (currentInfo && currentPos) {
              const currentCenterY = currentPos[1] + currentInfo.height / 2;
              const diff = avgCenterY - currentCenterY;
              if (diff !== 0) {
                // Recursively shift this node and its predecessors
                const shiftNodeAndPredecessors = (currName: string, shiftVal: number, visitedNodes = new Set<string>()) => {
                  if (visitedNodes.has(currName)) return;
                  visitedNodes.add(currName);

                  const posVal = branchPositions.get(currName);
                  if (posVal) {
                    posVal[1] += shiftVal;
                    branchPositions.set(currName, posVal);
                  }

                  // Find predecessors
                  for (const predName of branch) {
                    if (predName === currName || childToParent.has(predName)) continue;
                    const predOutputs = connections[predName];
                    if (predOutputs) {
                      let connectsToCurr = false;
                      let totalOutputs = 0;
                      for (const dGroups of Object.values(predOutputs as Record<string, any[][]>)) {
                        if (!dGroups) continue;
                        for (const grp of dGroups) {
                          if (!grp) continue;
                          for (const c of grp) {
                            if (c && c.node && branch.includes(c.node) && !childToParent.has(c.node)) {
                              totalOutputs++;
                              if (c.node === currName) {
                                connectsToCurr = true;
                              }
                            }
                          }
                        }
                      }

                      if (connectsToCurr && totalOutputs === 1) {
                        shiftNodeAndPredecessors(predName, shiftVal, visitedNodes);
                      }
                    }
                  }
                };

                shiftNodeAndPredecessors(nodeName, diff);
              }
            }
          }
        }
      }
    }



    // 2. Place subnodes of this branch's nodes
    const queue = branch.filter(name => !childToParent.has(name) && branchPositions.has(name));
    const processed = new Set<string>(queue);

    while (queue.length > 0) {
      const parentName = queue.shift()!;
      const children = (subnodesMap.get(parentName) || []).filter(c => branch.includes(c));
      if (children.length === 0) continue;

      // Sort children by Category to match ports: Model, Memory, Tools, Output Parser
      children.sort((a, b) => {
        const infoA = nodeInfoMap.get(a)!;
        const infoB = nodeInfoMap.get(b)!;
        
        const getCategoryScore = (info: any) => {
          const outs = info.outputs || [];
          if (outs.includes('ai_languageModel') || outs.includes('ai_model')) return 1;
          if (outs.includes('ai_memory')) return 2;
          if (outs.includes('ai_tool')) return 3;
          if (outs.includes('ai_outputParser')) return 4;
          return 5;
        };
        
        return getCategoryScore(infoA) - getCategoryScore(infoB);
      });

      const parentPos = branchPositions.get(parentName)!;
      const parentInfo = nodeInfoMap.get(parentName)!;

      let totalChildrenWidth = 0;
      const spacing = options.subnodeHorizontalSep !== undefined ? options.subnodeHorizontalSep : (options.grid || 20) * 4; // default 80px spacing to prevent label overlaps
      for (const childName of children) {
        const childInfo = nodeInfoMap.get(childName)!;
        totalChildrenWidth += childInfo.width;
      }
      totalChildrenWidth += (children.length - 1) * spacing;

      let currentX = parentPos[0] + (parentInfo.width - totalChildrenWidth) / 2;
      const subnodeSep = options.subnodeSep !== undefined ? options.subnodeSep : (options.ranksep !== undefined ? options.ranksep + 2 * (options.grid || 20) : 160);
      const childY = parentPos[1] + parentInfo.height + subnodeSep;

      for (const childName of children) {
        const childInfo = nodeInfoMap.get(childName)!;
        branchPositions.set(childName, [currentX, childY]);
        currentX += childInfo.width + spacing;

        if (!processed.has(childName)) {
          processed.add(childName);
          queue.push(childName);
        }
      }
    }

    // 3. Find bounding box of all nodes in branch (including subnodes)
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const nodeName of branch) {
      const pos = branchPositions.get(nodeName);
      if (!pos) continue;
      const info = nodeInfoMap.get(nodeName)!;
      const x = pos[0];
      const y = pos[1];

      if (x < minX) minX = x;
      if (x + info.width > maxX) maxX = x + info.width;
      if (y < minY) minY = y;
      if (y + info.height > maxY) maxY = y + info.height;
    }

    // Shift to 0,0
    const branchW = maxX - minX;
    const branchH = maxY - minY;
    for (const nodeName of branch) {
      const pos = branchPositions.get(nodeName);
      if (pos) {
        branchPositions.set(nodeName, [pos[0] - minX, pos[1] - minY]);
      }
    }



    // Find original center and top-left bounding box
    let origSumX = 0;
    let origSumY = 0;
    let origMinX = Infinity;
    let origMinY = Infinity;
    let mainNodeCount = 0;
    for (const nodeName of branch) {
      if (childToParent.has(nodeName)) continue; // skip subnodes for orig calculations
      const node = nodeMap.get(nodeName);
      if (!node) continue;
      const [posValX, posValY] = node.position || [0, 0];
      origSumX += posValX;
      origSumY += posValY;
      if (posValX < origMinX) origMinX = posValX;
      if (posValY < origMinY) origMinY = posValY;
      mainNodeCount++;
    }
    if (mainNodeCount === 0) {
      origMinX = 0;
      origMinY = 0;
      origSumX = 0;
      origSumY = 0;
      mainNodeCount = 1;
    }
    const origCenter: [number, number] = [origSumX / mainNodeCount, origSumY / mainNodeCount];

    branchLayouts.push({
      nodes: branch,
      width: branchW,
      height: branchH,
      origCenter,
      origMinX,
      origMinY,
      positions: branchPositions
    });
  }

  // 5. Branch Positioning and Overlap Resolution
  // Sort branches based on original coordinates (primary: X, secondary: Y)
  branchLayouts.sort((a, b) => a.origMinX - b.origMinX || a.origMinY - b.origMinY);

  const placedBranches: Array<{ x: number; y: number; width: number; height: number }> = [];

  for (const bLayout of branchLayouts) {
    let branchX = bLayout.origMinX;
    let branchY = bLayout.origMinY;
    const MARGIN = 80;

    let overlapping = true;
    while (overlapping) {
      overlapping = false;
      for (const placed of placedBranches) {
        const overlapX = (branchX < placed.x + placed.width + MARGIN) && (branchX + bLayout.width + MARGIN > placed.x);
        const overlapY = (branchY < placed.y + placed.height + MARGIN) && (branchY + bLayout.height + MARGIN > placed.y);
        if (overlapX && overlapY) {
          // Push to the right
          branchX = placed.x + placed.width + MARGIN;
          overlapping = true;
          break;
        }
      }
    }

    // Save final absolute positions of nodes in this branch
    for (const [nodeName, relPos] of bLayout.positions) {
      newPositions.set(nodeName, [branchX + relPos[0], branchY + relPos[1]]);
    }

    placedBranches.push({
      x: branchX,
      y: branchY,
      width: bLayout.width,
      height: bLayout.height
    });
  }

  // 6. Sticky Note Sizing and Placement
  const finalNotes = [];
  for (const note of stickyNotes) {
    const children = stickyNoteInclusions.get(note.name) || [];
    const info = nodeInfoMap.get(note.name)!;

    let noteW = info.width;
    let noteH = info.height;
    let noteX = note.position ? note.position[0] : 0;
    let noteY = note.position ? note.position[1] : 0;

    if (children.length > 0) {
      // Find bounding box of newly placed children
      let childMinX = Infinity;
      let childMaxX = -Infinity;
      let childMinY = Infinity;
      let childMaxY = -Infinity;

      for (const childName of children) {
        const pos = newPositions.get(childName)!;
        const childInfo = nodeInfoMap.get(childName)!;
        if (pos[0] < childMinX) childMinX = pos[0];
        if (pos[0] + childInfo.width > childMaxX) childMaxX = pos[0] + childInfo.width;
        if (pos[1] < childMinY) childMinY = pos[1];
        if (pos[1] + childInfo.height > childMaxY) childMaxY = pos[1] + childInfo.height;
      }

      // Add margins (padding)
      const paddingX = 32;
      const paddingY = 32;
      
      const widthAvailableForText = Math.max(240, childMaxX - childMinX + 2 * paddingX);
      const textHeight = estimateTextHeight(note.parameters?.content, widthAvailableForText);

      noteW = widthAvailableForText;
      noteH = (childMaxY - childMinY) + 2 * paddingY + textHeight;
      noteX = childMinX - paddingX;
      noteY = childMinY - paddingY - textHeight;
    }

    newPositions.set(note.name, [noteX, noteY]);
    finalNotes.push({
      ...note,
      parameters: {
        ...note.parameters,
        width: noteW,
        height: noteH
      }
    });
  }

  // 7. Snap to Grid & Final Assembly
  const grid = options.grid || 20;

  const snapValue = (val: number) => Math.round(val / grid) * grid;

  // Snapped positions
  const snappedPositions = new Map<string, [number, number]>();
  for (const node of nodes) {
    const pos = newPositions.get(node.name) || node.position || [0, 0];
    snappedPositions.set(node.name, [snapValue(pos[0]), snapValue(pos[1])]);
  }

  // Find connected pairs that were aligned before snapping, and adjust them to remain aligned
  const connectedPairs: Array<[string, string]> = [];
  for (const [srcName, outputsObj] of Object.entries(connections)) {
    const srcOutputs = outputsObj as Record<string, any[][]>;
    for (const destGroups of Object.values(srcOutputs)) {
      if (!destGroups) continue;
      for (const group of destGroups) {
        if (!group) continue;
        for (const conn of group) {
          if (conn && conn.node) {
            connectedPairs.push([srcName, conn.node]);
          }
        }
      }
    }
  }

  for (const [nodeA, nodeB] of connectedPairs) {
    const posA = newPositions.get(nodeA);
    const posB = newPositions.get(nodeB);
    const infoA = nodeInfoMap.get(nodeA);
    const infoB = nodeInfoMap.get(nodeB);
    
    if (posA && posB && infoA && infoB) {
      const centerA = posA[1] + infoA.height / 2;
      const centerB = posB[1] + infoB.height / 2;
      
      if (Math.abs(centerA - centerB) < 1.0) {
        const snappedA = snappedPositions.get(nodeA)!;
        const snappedB = snappedPositions.get(nodeB)!;
        
        const snappedCenterA = snappedA[1] + infoA.height / 2;
        const snappedCenterB = snappedB[1] + infoB.height / 2;
        
        if (snappedCenterA !== snappedCenterB) {
          if (infoB.height !== 96 && infoA.height === 96) {
            const newY_B = snappedCenterA - infoB.height / 2;
            snappedPositions.set(nodeB, [snappedB[0], newY_B]);
          } else if (infoA.height !== 96 && infoB.height === 96) {
            const newY_A = snappedCenterB - infoA.height / 2;
            snappedPositions.set(nodeA, [snappedA[0], newY_A]);
          } else {
            const newY_B = snappedCenterA - infoB.height / 2;
            snappedPositions.set(nodeB, [snappedB[0], newY_B]);
          }
        }
      }
    }
  }

  const finalNodes = nodes.map((node: any) => {
    const snappedPos = snappedPositions.get(node.name) || node.position || [0, 0];
    const info = nodeInfoMap.get(node.name);

    if (node.type === 'n8n-nodes-base.stickyNote') {
      const noteInstance = finalNotes.find(fn => fn.name === node.name);
      return {
        ...node,
        position: snappedPos,
        parameters: {
          ...node.parameters,
          width: snapValue(noteInstance?.parameters?.width || 240),
          height: snapValue(noteInstance?.parameters?.height || 160)
        }
      };
    }

    return {
      ...node,
      position: snappedPos
    };
  });

  return {
    ...workflowJson,
    nodes: finalNodes
  };
}
