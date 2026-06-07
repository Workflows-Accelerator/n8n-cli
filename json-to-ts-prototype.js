    const workflowData = $json;
const nodes = workflowData.nodes || [];
const connections = workflowData.connections || {};

const imports = new Set(['workflow', 'node', 'trigger', 'newCredential', 'expr']);

const sanitizeName = (str) => {
  const camel = str.replace(/[^a-zA-Z0-9_]/g, ' ').split(/\s+/).filter(Boolean)
    .map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return camel || 'node';
};

const varMap = {};
const getVarName = (name) => {
  if (!varMap[name]) {
    let base = sanitizeName(name);
    let finalName = base;
    let counter = 1;
    while (Object.values(varMap).includes(finalName)) {
      finalName = base + counter++;
    }
    varMap[name] = finalName;
  }
  return varMap[name];
};

// 1. Identify Subnodes and Roles
const subnodeMap = {}; 
const roleMapping = {
  'ai_languageModel': 'model', 'ai_tool': 'tools', 'ai_memory': 'memory',
  'ai_outputParser': 'outputParser', 'ai_embedding': 'embedding',
  'ai_vectorStore': 'vectorStore', 'ai_retriever': 'retriever',
  'ai_documentLoader': 'documentLoader', 'ai_textSplitter': 'textSplitter'
};

const isSubnode = new Set();
const hasIncomingMain = new Set();

for (const [sourceName, typeMap] of Object.entries(connections)) {
  for (const [connType, outputs] of Object.entries(typeMap)) {
    if (connType === 'main') {
      outputs.forEach(group => group.forEach(target => hasIncomingMain.add(target.node)));
    } else if (connType.startsWith('ai_')) {
      isSubnode.add(sourceName);
      const role = roleMapping[connType] || connType.replace('ai_', '');
      outputs.forEach(group => group.forEach(target => {
        if (!subnodeMap[target.node]) subnodeMap[target.node] = {};
        if (!subnodeMap[target.node][role]) subnodeMap[target.node][role] = [];
        subnodeMap[target.node][role].push(sourceName);
      }));
    }
  }
}

// 2. Transpile Node Definitions
function transformParams(obj) {
  if (Array.isArray(obj)) return obj.map(transformParams);
  if (obj !== null && typeof obj === 'object') {
    const newObj = {};
    for (const key in obj) newObj[key] = transformParams(obj[key]);
    return newObj;
  }
  if (typeof obj === 'string') {
    if (obj.startsWith('=')) {
      let exp = obj.substring(1);
      if (!exp.includes('{{')) exp = `{{ ${exp} }}`;
      return `__EXPR__${exp}__EXPR_END__`;
    }
    if (obj.includes('{{') && obj.includes('}}')) return `__EXPR__${obj}__EXPR_END__`;
  }
  return obj;
}

const nodeDeclarations = [];
const sortedNodes = [...nodes].sort((a, b) => (isSubnode.has(a.name) ? 0 : 1) - (isSubnode.has(b.name) ? 0 : 1));

sortedNodes.forEach(n => {
  let varName = getVarName(n.name);
  let factory = 'node';
  if (isSubnode.has(n.name)) {
    if (n.type.includes('languageModel') || n.type.includes('lmChat')) factory = 'languageModel';
    else if (n.type.includes('tool') || n.type.includes('Tool')) factory = 'tool';
    else if (n.type.includes('memory')) factory = 'memory';
    else factory = 'node';
  } else if (n.type.includes('Trigger') || n.type.includes('Webhook')) {
    factory = 'trigger';
  }
  imports.add(factory);

  const config = { name: n.name, parameters: transformParams(n.parameters || {}), position: n.position || [0, 0] };
  if (n.credentials) {
    config.credentials = {};
    for (const [k, v] of Object.entries(n.credentials)) config.credentials[k] = `__CRED__${v.name || k}__CRED_END__`;
  }

  let configStr = JSON.stringify(config, null, 2)
    .replace(/"__EXPR__(.*?)__EXPR_END__"/g, (m, p1) => `expr('${p1.replace(/'/g, "\\'")}')`)
    .replace(/"__CRED__(.*?)__CRED_END__"/g, (m, p1) => `newCredential('${p1.replace(/'/g, "\\'")}')`);

  if (subnodeMap[n.name]) {
    const subs = Object.entries(subnodeMap[n.name]).map(([r, s]) => `${r}: ${r === 'tools' ? `[${s.map(getVarName).join(', ')}]` : getVarName(s[0])}`);
    configStr = configStr.replace(/\n\}$/, `,\n    subnodes: { ${subs.join(', ')} }\n  }`);
  }

  nodeDeclarations.push(`const ${varName} = ${factory}({\n  type: '${n.type}',\n  version: ${n.typeVersion || 1},\n  config: ${configStr.split('\n').map((l, i) => i === 0 ? l : '  ' + l).join('\n')}${factory === 'node' ? ',\n  output: [{}]' : ''}\n});\n`);
});

// 3. Branch-Aware Graph Walker
const visitedConnections = new Set();

function walk(nodeName) {
  const nodeObj = nodes.find(n => n.name === nodeName);
  const nodeVar = getVarName(nodeName);
  const nodeConns = connections[nodeName]?.['main'];

  if (!nodeConns) return nodeVar;

  // Handle Logic Nodes (IF/Switch)
  if (nodeObj?.type === 'n8n-nodes-base.if') {
    const trueBranch = nodeConns[0] ? walk(nodeConns[0][0].node) : '';
    const falseBranch = nodeConns[1] ? walk(nodeConns[1][0].node) : '';
    let res = `${nodeVar}`;
    if (trueBranch) res += `\n    .onTrue(${trueBranch})`;
    if (falseBranch) res += `\n    .onFalse(${falseBranch})`;
    return res;
  }

  if (nodeObj?.type === 'n8n-nodes-base.switch') {
    let res = `${nodeVar}`;
    nodeConns.forEach((targets, idx) => {
      if (targets && targets.length > 0) res += `\n    .onCase(${idx}, ${walk(targets[0].node)})`;
    });
    return res;
  }

  // Handle Standard Chain
  const targetNodeName = nodeConns[0]?.[0]?.node;
  if (targetNodeName) {
    return `${nodeVar}.to(${walk(targetNodeName)})`;
  }

  return nodeVar;
}

// 4. Final Assembly
let composition = `export default workflow('${workflowData.id || 'id'}', '${workflowData.name || 'name'}')`;

// Start from every node that has no incoming main connections (Triggers or independent starts)
const startNodes = nodes.filter(n => !hasIncomingMain.has(n.name) && !isSubnode.has(n.name));

startNodes.forEach(sn => {
  composition += `\n  .add(${walk(sn.name)})`;
});

const importStr = `import { ${Array.from(imports).sort().join(', ')} } from '@n8n/workflow-sdk';\n\n`;
return { json: { code: importStr + nodeDeclarations.join('\n') + '\n' + composition + ';' } };