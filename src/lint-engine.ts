import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateWorkflowCode } from '@n8n/workflow-sdk';
import { createRequire } from 'module';
import * as output from './output.js';
import { dbMetadataCache, cleanNodeType } from './layout-engine.js';
const require = createRequire(import.meta.url);

// Safe require for spell-checker-js
let spell: any = null;
let isSpellcheckLoaded = false;
try {
  spell = require('spell-checker-js');
  spell.load('en');
  isSpellcheckLoaded = true;
} catch (e) {
  // Silent fallback
}

export interface StandardsConfig {
  folders?: {
    naming?: {
      regex?: string;
      errorMessage?: string;
    };
  };
  workflows?: {
    naming?: {
      regex?: string;
      errorMessage?: string;
    };
    requireDescription?: boolean;
    requireTags?: boolean;
    minTags?: number;
    bannedNames?: string[];
  };
  nodes?: {
    naming?: {
      tolerateDefaultNames?: boolean;
      duplicateSuffixFormat?: 'parenthesis' | 'simple';
      regex?: string;
      errorMessage?: string;
    };
    notes?: {
      requireNotes?: boolean;
      requireNotesForTypes?: string[];
      errorMessage?: string;
    };
    stickyNotes?: {
      ignore?: boolean;
      markdownValidation?: boolean;
      colors?: {
        needFixing?: number;
        specs?: number;
        futureImprovements?: number;
        needsHumanHelp?: number;
      };
    };
  };
  variables?: {
    naming?: {
      convention?: 'camelCase' | 'PascalCase' | 'snake_case';
      errorMessage?: string;
    };
  };
  language?: {
    enabled?: boolean;
    expected?: string;
    checkFields?: string[];
    allowedWords?: string[];
    _comment_allowedWords?: string;
    errorMessage?: string;
  };
  ignore?: {
    workflows?: string[];
    folders?: string[];
    nodes?: string[];
    variables?: string[];
    words?: string[];
  };
  ignoreRules?: {
    nodes?: {
      titleCase?: string[];
      namingRegex?: string[];
      duplicateSuffix?: string[];
      notes?: string[];
    };
  };
}

export const DEFAULT_STANDARDS: StandardsConfig = {
  folders: {
    naming: {
      regex: '^[A-Z][a-zA-Z0-9\\s()-]*$',
      errorMessage: 'Folder names must be in Title Case (starting with uppercase) and can contain letters, numbers, spaces, dashes, or parentheses.'
    }
  },
  workflows: {
    naming: {
      regex: '^[A-Z][a-zA-Z0-9\\s()-]*$',
      errorMessage: 'Workflow names must be in Title Case (starting with uppercase) and can contain letters, numbers, spaces, dashes, or parentheses.'
    },
    requireDescription: true,
    requireTags: false,
    minTags: 0,
    bannedNames: []
  },
  nodes: {
    naming: {
      tolerateDefaultNames: true,
      duplicateSuffixFormat: 'parenthesis',
      regex: '^[A-Z][a-zA-Z0-9\\s()\\-:/]*$',
      errorMessage: 'Node names must be in Title Case (starting with uppercase) and can contain letters, numbers, spaces, dashes, parentheses, colons, or forward slashes.'
    },
    notes: {
      requireNotes: false,
      requireNotesForTypes: ['n8n-nodes-base.code'],
      errorMessage: 'Notes are required for Code nodes to explain their logic.'
    },
    stickyNotes: {
      ignore: false,
      markdownValidation: true,
      colors: {
        needFixing: 1,
        specs: 2,
        futureImprovements: 3,
        needsHumanHelp: 4
      }
    }
  },
  variables: {
    naming: {
      convention: 'camelCase',
      errorMessage: 'Variables declared in Set/Edit Fields nodes must be in camelCase.'
    }
  },
  language: {
    enabled: true,
    expected: 'en',
    checkFields: ['workflow.description', 'node.notes', 'node.name', 'variable.name'],
    allowedWords: [
      'PDF', 'SMS', 'API', 'Gemini', 'Supabase', 'Twilio', 'Gotenberg', 'n8n', 'JSON', 'URL',
      'HTTP', 'HTTPS', 'REST', 'SQL', 'DB', 'OAuth', 'Webhook', 'CRM', 'AI', 'LLM', 'Slack',
      'Discord', 'Telegram', 'WhatsApp', 'Google', 'GitHub', 'Stripe', 'PayPal', 'HubSpot',
      'Notion', 'Airtable', 'Asana', 'Jira', 'Trello', 'SendGrid', 'Mailgun'
    ],
    _comment_allowedWords: 'Add custom words here that are specific to your workflows to prevent spelling warnings.',
    errorMessage: 'Text, names, and variables must be written in English.'
  },
  ignore: {
    workflows: [],
    folders: [],
    nodes: [],
    variables: [],
    words: []
  }
};

const DEFAULT_ALLOWED_TECHNICAL_WORDS = new Set([
  'n8n', 'mcp', 'url', 'http', 'api', 'json', 'db', 'id', 'uuid', 'sdk', 
  'ts', 'js', 'oauth', 'jwt', 'ssl', 'tls', 'xml', 'html', 'csv', 'cron', 
  'get', 'post', 'put', 'delete', 'patch', 'git', 'cli', 'env', 'config', 
  'ref', 'port', 'host', 'ip', 'dns', 'uri', 'graphql', 'rest', 'ftp', 
  'sftp', 'ssh', 'regex', 'regexp', 'sql', 'postgres', 'mysql', 'mongodb', 
  'redis', 'aws', 's3', 'gcp', 'azure', 'webhook', 'webhooks', 'headers', 
  'params', 'body', 'query', 'payload', 'token', 'auth', 'casing', 'camel', 
  'snake', 'pascal', 'string', 'boolean', 'integer', 'number', 'array', 
  'object', 'null', 'undefined', 'async', 'await', 'const', 'let', 'var', 
  'func', 'function', 'class', 'import', 'export', 'node', 'nodes', 'workflow', 
  'workflows', 'folder', 'folders', 'project', 'projects', 'error', 'errors', 
  'warn', 'warning', 'info', 'log', 'logs', 'debug', 'trace', 'client', 'server', 
  'response', 'request', 'status', 'credential', 'credentials', 'trigger', 
  'active', 'inactive', 'publish', 'unpublish', 'set', 'edit', 'fields', 
  'email', 'slack', 'gmail', 'github', 'gitlab', 'hubspot', 'trello', 'asana', 
  'jira', 'notion', 'airtable', 'stripe', 'paypal', 'mailgun', 'sendgrid', 
  'twilio', 'telegram', 'discord', 'whatsapp', 'google', 'drive', 'sheets', 
  'calendar', 'docs', 'forms', 'meet', 'chat', 'fit', 'photos', 'keep',
  'pdf', 'sms', 'gemini', 'supabase', 'gotenberg'
]);

export function getStandardsPath(repoRoot: string): string {
  const localConfig = path.join(repoRoot, 'n8n', 'config', 'n8n-standards.json');
  if (fs.existsSync(localConfig)) {
    return localConfig;
  }
  const rootConfig = path.join(repoRoot, 'n8n-standards.json');
  if (fs.existsSync(rootConfig)) {
    return rootConfig;
  }
  return localConfig;
}

export function loadStandards(repoRoot: string): StandardsConfig {
  const p = getStandardsPath(repoRoot);
  if (fs.existsSync(p)) {
    try {
      const content = fs.readFileSync(p, 'utf-8');
      return JSON.parse(content) as StandardsConfig;
    } catch (e) {
      // ignore
    }
  }

  // Check global standards file fallback
  const globalConfig = path.join(os.homedir(), '.n8n-standards.json');
  if (fs.existsSync(globalConfig)) {
    try {
      const content = fs.readFileSync(globalConfig, 'utf-8');
      return JSON.parse(content) as StandardsConfig;
    } catch (e) {
      // ignore
    }
  }

  return DEFAULT_STANDARDS;
}

export function saveDefaultStandards(repoRoot: string) {
  const p = getStandardsPath(repoRoot);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(p, JSON.stringify(DEFAULT_STANDARDS, null, 2), 'utf-8');
}

export function addAllowedWords(repoRoot: string, words: string[]) {
  const p = getStandardsPath(repoRoot);
  let config: StandardsConfig;
  if (fs.existsSync(p)) {
    try {
      config = JSON.parse(fs.readFileSync(p, 'utf-8')) as StandardsConfig;
    } catch (e) {
      config = { ...DEFAULT_STANDARDS };
    }
  } else {
    config = { ...DEFAULT_STANDARDS };
  }

  if (!config.language) {
    config.language = {};
  }
  if (!config.language.allowedWords) {
    config.language.allowedWords = [];
  }

  for (const word of words) {
    if (!config.language.allowedWords.includes(word)) {
      config.language.allowedWords.push(word);
    }
  }

  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf-8');
}

export function checkWordSpelling(word: string): boolean {
  if (!isSpellcheckLoaded || !spell) return true;
  const cleanWord = word.trim().replace(/[^a-zA-Z]/g, '');
  if (!cleanWord || cleanWord.length <= 1) return true; // Ignore single letters
  try {
    const wrong = spell.check(cleanWord);
    return wrong.length === 0;
  } catch (e) {
    return true;
  }
}

export function splitIdentifierIntoWords(identifier: string): string[] {
  const spaced = identifier
    .replace(/[-_]+/g, ' ')
    .replace(/([A-Z][a-z])/g, ' $1')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
  
  return spaced
    .split(/[^a-zA-Z]/)
    .map(w => w.trim())
    .filter(w => w.length > 0);
}

export function isWordEnglish(word: string, customAllowedWords: string[] = [], ignoredWords: string[] = []): boolean {
  const lower = word.toLowerCase();
  if (DEFAULT_ALLOWED_TECHNICAL_WORDS.has(lower)) {
    return true;
  }
  if (customAllowedWords.some(w => w.toLowerCase() === lower)) {
    return true;
  }
  if (ignoredWords.some(w => w.toLowerCase() === lower)) {
    return true;
  }
  return checkWordSpelling(lower);
}

export function checkSentenceSpelling(
  text: string,
  customAllowedWords: string[] = [],
  ignoredWords: string[] = []
): { ok: boolean; invalidWords: string[] } {
  if (!isSpellcheckLoaded || !spell) return { ok: true, invalidWords: [] };
  
  const words = text
    .replace(/[^a-zA-Z\s'-]/g, ' ')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length > 0);
  
  const invalidWords: string[] = [];
  for (const word of words) {
    if (!isWordEnglish(word, customAllowedWords, ignoredWords)) {
      invalidWords.push(word);
    }
  }
  
  return {
    ok: invalidWords.length === 0,
    invalidWords
  };
}

function validateMarkdown(content: string): string[] {
  const errors: string[] = [];
  
  const codeBlockCount = (content.match(/```/g) || []).length;
  if (codeBlockCount % 2 !== 0) {
    errors.push("Unclosed code block (odd number of triple backticks).");
  }

  const inlineCodeCount = (content.match(/`/g) || []).length;
  const singleBackticks = inlineCodeCount - (codeBlockCount * 3);
  if (singleBackticks > 0 && singleBackticks % 2 !== 0) {
    errors.push("Unclosed inline code block (odd number of single backticks).");
  }

  const openBrackets = (content.match(/\[/g) || []).length;
  const closeBrackets = (content.match(/\]/g) || []).length;
  if (openBrackets !== closeBrackets) {
    errors.push(`Mismatched link brackets: found ${openBrackets} '[' and ${closeBrackets} ']'.`);
  }

  return errors;
}

function isPatternMatched(target: string, pattern: string): boolean {
  if (pattern === target) return true;
  try {
    let p = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*');
    const regex = new RegExp(`^${p}$`, 'i');
    return regex.test(target);
  } catch (e) {
    return false;
  }
}

export function isIgnored(target: string, ignoreList: string[] | undefined): boolean {
  if (!target || !ignoreList || ignoreList.length === 0) return false;
  return ignoreList.some(pattern => isPatternMatched(target, pattern));
}

function extractVariableNames(parameters: any): string[] {
  const names: string[] = [];
  
  function recurse(obj: any) {
    if (!obj || typeof obj !== 'object') return;
    
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (item && typeof item === 'object') {
          if (typeof item.name === 'string') {
            names.push(item.name);
          }
          recurse(item);
        }
      }
    } else {
      for (const key of Object.keys(obj)) {
        recurse(obj[key]);
      }
    }
  }
  
  recurse(parameters);
  return names;
}

function checkCasing(name: string, convention: 'camelCase' | 'PascalCase' | 'snake_case'): boolean {
  if (convention === 'camelCase') {
    return /^[a-z][a-zA-Z0-9]*$/.test(name);
  }
  if (convention === 'PascalCase') {
    return /^[A-Z][a-zA-Z0-9]*$/.test(name);
  }
  if (convention === 'snake_case') {
    return /^[a-z0-9]+(_[a-z0-9]+)*$/.test(name);
  }
  return true;
}

export function toSmartTitleCase(str: string, standards?: StandardsConfig): string {
  if (!str) return str;

  const TRANSITION_WORDS = new Set([
    'a', 'an', 'the', 'and', 'but', 'for', 'or', 'nor', 'to', 'with', 
    'about', 'in', 'on', 'at', 'by', 'from', 'of', 'into', 'onto', 
    'than', 'via', 'within', 'without', 'as'
  ]);

  const COMMON_ABBREVIATIONS = new Map<string, string>([
    ['api', 'API'],
    ['json', 'JSON'],
    ['http', 'HTTP'],
    ['xml', 'XML'],
    ['html', 'HTML'],
    ['db', 'DB'],
    ['url', 'URL'],
    ['id', 'ID'],
    ['n8n', 'n8n'],
    ['mcp', 'MCP'],
    ['oauth', 'OAuth'],
    ['uuid', 'UUID']
  ]);

  const allowedWords = new Set<string>();
  if (standards?.language?.allowedWords) {
    for (const w of standards.language.allowedWords) allowedWords.add(w.toLowerCase());
  }
  if (standards?.ignore?.words) {
    for (const w of standards.ignore.words) allowedWords.add(w.toLowerCase());
  }

  const tokens = str.split(/([^\p{L}\d]+)/u);
  const wordIndices: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (/[\p{L}\d]/u.test(tokens[i])) {
      wordIndices.push(i);
    }
  }

  if (wordIndices.length === 0) return str;

  const firstWordIndex = wordIndices[0];
  const lastWordIndex = wordIndices[wordIndices.length - 1];

  for (const idx of wordIndices) {
    const token = tokens[idx];
    const lowerToken = token.toLowerCase();

    let matchedWord = '';
    if (standards?.language?.allowedWords) {
      const found = standards.language.allowedWords.find(w => w.toLowerCase() === lowerToken);
      if (found) matchedWord = found;
    }
    if (!matchedWord && standards?.ignore?.words) {
      const found = standards.ignore.words.find(w => w.toLowerCase() === lowerToken);
      if (found) matchedWord = found;
    }
    if (!matchedWord && COMMON_ABBREVIATIONS.has(lowerToken)) {
      matchedWord = COMMON_ABBREVIATIONS.get(lowerToken)!;
    }

    if (matchedWord) {
      tokens[idx] = matchedWord;
    } else if (idx === firstWordIndex || idx === lastWordIndex) {
      tokens[idx] = token.charAt(0).toUpperCase() + token.slice(1);
    } else if (TRANSITION_WORDS.has(lowerToken)) {
      tokens[idx] = lowerToken;
    } else {
      tokens[idx] = token.charAt(0).toUpperCase() + token.slice(1);
    }
  }

  return tokens.join('');
}

function renameNodeInExpressions(modifiedJson: any, oldName: string, newName: string): number {
  let count = 0;
  const escapedOld = oldName.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const mcpPattern = new RegExp(`\\$\\(\\s*(['"\`])${escapedOld}\\1\\s*\\)`, 'g');
  const nodePattern = new RegExp(`\\$node\\[\\s*(['"])${escapedOld}\\1\\s*\\]`, 'g');

  function updateString(val: string): string {
    if (!val.includes('{{') || !val.includes('}}')) {
      return val;
    }

    let updated = val;

    updated = updated.replace(mcpPattern, (match, quote) => {
      count++;
      output.warn(`[EXPRESSION-UPDATE] Updated reference to node "${oldName}" -> "${newName}" in expression: ${match}`);
      return `\$(${quote}${newName}${quote})`;
    });

    updated = updated.replace(nodePattern, (match, quote) => {
      count++;
      output.warn(`[EXPRESSION-UPDATE] Updated reference to node "${oldName}" -> "${newName}" in expression: ${match}`);
      return `\$node\[${quote}${newName}${quote}\]`;
    });

    return updated;
  }

  function recurse(obj: any) {
    if (!obj || typeof obj !== 'object') return;

    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (typeof val === 'string') {
        obj[key] = updateString(val);
      } else if (typeof val === 'object') {
        recurse(val);
      }
    }
  }

  if (modifiedJson.nodes) {
    for (const node of modifiedJson.nodes) {
      if (node.parameters) {
        recurse(node.parameters);
      }
    }
  }

  return count;
}

function evaluateOutputsExpression(expr: string, parameters: any): any[] {
  if (expr.startsWith('={{') && expr.endsWith('}}')) {
    const jsCode = expr.slice(3, -2).trim();
    try {
      const fn = new Function('$parameter', `return (${jsCode});`);
      const res = fn(parameters || {});
      if (Array.isArray(res)) {
        return res;
      }
    } catch (e) {
      // Fallback
    }
  }
  return [];
}

export function getNodeMaxAllowedOutputs(node: any): number {
  const nodeType = node.type || '';

  // 1. Filter node override (only Keep output is connectable, Discard is not)
  if (nodeType === 'n8n-nodes-base.filter') {
    let count = 1;
    if (node.onError === 'continueErrorOutput' || node.settings?.onError === 'continueErrorOutput') {
      count += 1;
    }
    return count;
  }

  // 2. Lookup node metadata
  const cleanType = cleanNodeType(nodeType);
  const dbEntry = dbMetadataCache.get(cleanType);

  let baseOutputs = 1;
  if (dbEntry) {
    if (typeof dbEntry.outputs === 'string') {
      const expr = dbEntry.outputs;
      if (expr.startsWith('={{')) {
        const evaled = evaluateOutputsExpression(expr, node.parameters);
        baseOutputs = Math.max(1, evaled.length);
      } else {
        baseOutputs = 1;
      }
    } else if (Array.isArray(dbEntry.outputs)) {
      baseOutputs = dbEntry.outputs.length;
    }
  } else {
    // Fallback heuristic matching layout-engine
    if (nodeType.endsWith('Tool')) {
      baseOutputs = 1;
    } else if (nodeType === 'n8n-nodes-base.stickyNote') {
      baseOutputs = 0;
    } else {
      baseOutputs = 1;
    }
  }

  // Fallback for Switch node if DB is not loaded or evaluation returns <= 1
  if (nodeType === 'n8n-nodes-base.switch' && baseOutputs <= 1) {
    const rules = node.parameters?.rules?.values || [];
    const hasFallback = node.parameters?.options?.fallbackOutput !== 'none' && node.parameters?.options?.fallbackOutput !== undefined;
    baseOutputs = Math.max(1, rules.length + (hasFallback ? 1 : 0));
  }

  // 3. Error output settings option (adds 1 extra output if continueErrorOutput)
  const hasErrorOutput = node.onError === 'continueErrorOutput' || node.settings?.onError === 'continueErrorOutput';
  let count = baseOutputs;
  if (hasErrorOutput) {
    count += 1;
  }

  return count;
}

export function validateWorkflowAgainstStandards(
  workflowJson: any,
  standards: StandardsConfig,
  relativePath: string
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  const ignore = standards.ignore || {};
  const workflowId = workflowJson.id ? String(workflowJson.id) : '';
  const normalizedPath = relativePath.replace(/\\/g, '/');
  
  // 1. Check workflow ignores
  if (isIgnored(workflowId, ignore.workflows) || isIgnored(normalizedPath, ignore.workflows)) {
    return { errors: [], warnings: [] };
  }
  
  // 2. Folder checks (segment by segment)
  const folderParts = path.dirname(normalizedPath).split('/').filter(p => p && p !== '.' && p !== 'workflows' && p !== 'n8n');
  
  // Exclude entire folder from any validation of child elements if ignored
  const isParentFolderIgnored = folderParts.some(folderPart => isIgnored(folderPart, ignore.folders));
  if (isParentFolderIgnored) {
    return { errors: [], warnings: [] };
  }
 
  const folderRegex = standards.folders?.naming?.regex ? new RegExp(standards.folders.naming.regex) : null;
  const folderErrMessage = standards.folders?.naming?.errorMessage || (standards.folders?.naming?.regex ? `Folder name does not match regex: ${standards.folders.naming.regex}` : '');
  
  for (const folderPart of folderParts) {
    if (isIgnored(folderPart, ignore.folders)) {
      continue;
    }
    if (folderRegex && !folderRegex.test(folderPart)) {
      warnings.push(`Folder name "${folderPart}" violates naming standards. ${folderErrMessage}`);
    }
    const titleCased = toSmartTitleCase(folderPart, standards);
    if (folderPart !== titleCased) {
      warnings.push(`Folder name "${folderPart}" is not in Title Case. Expected "${titleCased}".`);
    }
  }
  
  // 3. Workflow name checks
  const workflowName = workflowJson.name || path.basename(normalizedPath, '.workflow.ts');
  if (standards.workflows?.naming?.regex) {
    const wfRegex = new RegExp(standards.workflows.naming.regex);
    const errMessage = standards.workflows.naming.errorMessage || `Workflow name does not match regex: ${standards.workflows.naming.regex}`;
    if (!wfRegex.test(workflowName)) {
      warnings.push(`Workflow name "${workflowName}" violates naming standards. ${errMessage}`);
    }
  }
  const titleCasedWf = toSmartTitleCase(workflowName, standards);
  if (workflowName !== titleCasedWf) {
    warnings.push(`Workflow name "${workflowName}" is not in Title Case. Expected "${titleCasedWf}".`);
  }
 
  // Check default or banned workflow names
  const workflowNameLower = workflowName.toLowerCase().trim();
  const defaultBanned = ['my workflow', 'new workflow', 'workflow', 'untitled workflow'];
  const userBanned = standards.workflows?.bannedNames || [];
  const allBanned = [...defaultBanned, ...userBanned].map(b => b.toLowerCase().trim());
  const isBannedWf = allBanned.some(b => {
    if (b === workflowNameLower) return true;
    const escapedB = b.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escapedB}\\s*\\d*$`, 'i');
    return regex.test(workflowNameLower);
  });
  if (isBannedWf) {
    warnings.push(`Workflow name "${workflowName}" is using a banned default name (e.g., "My workflow").`);
  }
  
  // Workflow Description Note Check
  if (standards.workflows?.requireDescription) {
    const desc = workflowJson.description || workflowJson.settings?.description;
    if (!desc || desc.trim() === '') {
      warnings.push(`Workflow is missing a description.`);
    }
  }
  
  // Workflow Tags Check
  if (standards.workflows?.requireTags) {
    const tags = workflowJson.tags || [];
    const minTags = standards.workflows.minTags || 1;
    if (tags.length < minTags) {
      warnings.push(`Workflow must have at least ${minTags} tag(s), but has ${tags.length}.`);
    }
  }
  
  const allowedWords = standards.language?.allowedWords || [];
  const ignoredWords = standards.ignore?.words || [];
  
  // Workflow Description Language Check
  if (standards.language?.enabled) {
    const checkFields = standards.language.checkFields || [];
    const desc = workflowJson.description || workflowJson.settings?.description;
    if (checkFields.includes('workflow.description') && desc) {
      const spellResult = checkSentenceSpelling(desc, allowedWords, ignoredWords);
      if (!spellResult.ok) {
        warnings.push(`Workflow description contains spelling or non-English words: ${spellResult.invalidWords.join(', ')}. (Tip: Use 'n8ncli standards allow <word>' to whitelist)`);
      }
    }
  }
  
  // 4. Node Checks
  const nodes = workflowJson.nodes || [];
  
  for (const node of nodes) {
    const nodeId = node.id ? String(node.id) : '';
    const nodeName = node.name || '';
    const nodeType = node.type || '';
    
    // Check if node is ignored
    if (isIgnored(nodeId, ignore.nodes) || isIgnored(nodeName, ignore.nodes) || isIgnored(nodeType, ignore.nodes)) {
      continue;
    }
 
    // Sticky Note Validation
    if (nodeType === 'n8n-nodes-base.stickyNote') {
      const stickyOpts = standards.nodes?.stickyNotes || {};
      if (stickyOpts.ignore === true) {
        continue;
      }
      
      const content = node.parameters?.content || '';
      
      // 1. Markdown validation
      if (stickyOpts.markdownValidation !== false && content) {
        const mdErrors = validateMarkdown(content);
        for (const mdErr of mdErrors) {
          warnings.push(`Sticky Note "${nodeName}" markdown error: ${mdErr}`);
        }
      }
      
      // 2. Color check
      if (stickyOpts.colors) {
        const nodeColor = node.parameters?.color;
        const validColors = Object.values(stickyOpts.colors).filter(c => c !== undefined) as number[];
        if (nodeColor !== undefined && validColors.length > 0 && !validColors.includes(nodeColor)) {
          warnings.push(`Sticky Note "${nodeName}" is using color ${nodeColor}, which is not in the approved colors: ${JSON.stringify(stickyOpts.colors)}.`);
        }
      }
      
      // Spelling check on content if enabled
      if (standards.language?.enabled && standards.language.checkFields?.includes('node.notes') && content) {
        const spellResult = checkSentenceSpelling(content, allowedWords, ignoredWords);
        if (!spellResult.ok) {
          warnings.push(`Sticky Note "${nodeName}" content contains spelling or non-English words: ${spellResult.invalidWords.join(', ')}. (Tip: Use 'n8ncli standards allow <word>' to whitelist)`);
        }
      }
      
      continue;
    }
    
    // Tolerate Default Node Names heuristic
    const typeParts = nodeType.split('.');
    const typeBase = typeParts[typeParts.length - 1] || '';
    const defaultDisplay = typeBase
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, str => str.toUpperCase())
      .trim();
    
    const isDefaultName = (nodeName.toLowerCase() === defaultDisplay.toLowerCase() || nodeName.toLowerCase() === typeBase.toLowerCase());
    
    if (isDefaultName && standards.nodes?.naming?.tolerateDefaultNames === false) {
      warnings.push(`Node "${nodeName}" is using the default name for node type "${nodeType}". Default names are banned.`);
    }
    
    // Enforce node naming regex
    if (!isDefaultName) {
      const isNamingRegexIgnored = isIgnored(nodeType, standards.ignoreRules?.nodes?.namingRegex) || isIgnored(nodeName, standards.ignoreRules?.nodes?.namingRegex);
      if (!isNamingRegexIgnored && standards.nodes?.naming?.regex) {
        const nodeRegex = new RegExp(standards.nodes.naming.regex);
        const errMessage = standards.nodes.naming.errorMessage || `Node name does not match regex: ${standards.nodes.naming.regex}`;
        if (!nodeRegex.test(nodeName)) {
          warnings.push(`Node name "${nodeName}" violates naming standards. ${errMessage}`);
        }
      }
      
      const isWebhookNode = nodeType === 'n8n-nodes-base.webhook';
      const isTitleCaseIgnored = isIgnored(nodeType, standards.ignoreRules?.nodes?.titleCase) || isIgnored(nodeName, standards.ignoreRules?.nodes?.titleCase);
      
      if (isWebhookNode) {
        const webhookPattern = /^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+\/[a-zA-Z0-9\-_\/\{\}:]*$/;
        if (!webhookPattern.test(nodeName)) {
          warnings.push(`Webhook trigger node name "${nodeName}" must follow the convention "[METHOD] /[endpoint]" (e.g., "POST /users").`);
        }
      } else if (!isTitleCaseIgnored) {
        const titleCasedNode = toSmartTitleCase(nodeName, standards);
        if (nodeName !== titleCasedNode) {
          warnings.push(`Node name "${nodeName}" is not in Title Case. Expected "${titleCasedNode}".`);
        }
      }
    }
    
    // Duplicate Suffix Check (e.g. Node1 vs Node (1))
    const isDuplicateSuffixIgnored = isIgnored(nodeType, standards.ignoreRules?.nodes?.duplicateSuffix) || isIgnored(nodeName, standards.ignoreRules?.nodes?.duplicateSuffix);
    if (!isDuplicateSuffixIgnored && standards.nodes?.naming?.duplicateSuffixFormat) {
      const format = standards.nodes.naming.duplicateSuffixFormat;
      const parenMatch = nodeName.match(/^(.+)\s\((\d+)\)$/);
      const simpleMatch = nodeName.match(/^(.+?)(\d+)$/);
      
      if (format === 'parenthesis') {
        if (simpleMatch && !parenMatch) {
          warnings.push(`Node "${nodeName}" has duplicate naming violation. Expected parenthesis format (e.g., "${simpleMatch[1]} (${simpleMatch[2]})") but got "${nodeName}".`);
        }
      } else if (format === 'simple') {
        if (parenMatch && !simpleMatch) {
          warnings.push(`Node "${nodeName}" has duplicate naming violation. Expected simple numbering format (e.g., "${parenMatch[1]}${parenMatch[2]}") but got "${nodeName}".`);
        }
      }
    }
    
    // Notes Check
    const hasNote = node.notesInFlow === true && typeof node.notes === 'string' && node.notes.trim() !== '';
    const isNotesIgnored = isIgnored(nodeType, standards.ignoreRules?.nodes?.notes) || isIgnored(nodeName, standards.ignoreRules?.nodes?.notes);
    if (!isNotesIgnored) {
      const requireNotes = standards.nodes?.notes?.requireNotes;
      const requireNotesForTypes = standards.nodes?.notes?.requireNotesForTypes || [];
      
      if (requireNotes || requireNotesForTypes.includes(nodeType)) {
        if (!hasNote) {
          const errMessage = standards.nodes.notes?.errorMessage || `Notes are required for node: ${nodeName}`;
          warnings.push(`Node "${nodeName}" is missing a description note. ${errMessage} (Note: In the TypeScript SDK, notes must be configured inside the .config({ notes: "...", notesInFlow: true }) block)`);
        }
      }
    }
    
    // Language check on Node Name and Notes
    if (standards.language?.enabled) {
      const checkFields = standards.language.checkFields || [];
      
      // Node Name Spelling Check
      if (checkFields.includes('node.name') && !isDefaultName) {
        const words = splitIdentifierIntoWords(nodeName);
        const invalidWords: string[] = [];
        for (const w of words) {
          if (!isWordEnglish(w, allowedWords, ignoredWords)) {
            invalidWords.push(w);
          }
        }
        if (invalidWords.length > 0) {
          warnings.push(`Node name "${nodeName}" contains spelling or non-English words: ${invalidWords.join(', ')}. (Tip: Use 'n8ncli standards allow <word>' to whitelist)`);
        }
      }
      
      // Node Notes Spelling Check
      if (checkFields.includes('node.notes') && hasNote && node.notes) {
        const spellResult = checkSentenceSpelling(node.notes, allowedWords, ignoredWords);
        if (!spellResult.ok) {
          warnings.push(`Node "${nodeName}" notes contain spelling or non-English words: ${spellResult.invalidWords.join(', ')}. (Tip: Use 'n8ncli standards allow <word>' to whitelist)`);
        }
      }
    }
    
    // Variable checks (for Set and Edit Fields nodes)
    const isSetNode = nodeType.startsWith('n8n-nodes-base.set') || nodeType === 'n8n-nodes-base.editFields';
    if (isSetNode && node.parameters) {
      const vars = extractVariableNames(node.parameters);
      const convention = standards.variables?.naming?.convention;
      const casingErrMessage = standards.variables?.naming?.errorMessage || `Variables must match convention: ${convention}`;
      
      for (const varName of vars) {
        if (isIgnored(varName, ignore.variables)) {
          continue;
        }
        
        // Casing Check
        if (convention && !checkCasing(varName, convention)) {
          warnings.push(`Variable "${varName}" in node "${nodeName}" violates casing convention. ${casingErrMessage}`);
        }
        
        // Language Check on Variable Names
        if (standards.language?.enabled && standards.language.checkFields?.includes('variable.name')) {
          const words = splitIdentifierIntoWords(varName);
          const invalidWords: string[] = [];
          for (const w of words) {
            if (!isWordEnglish(w, allowedWords, ignoredWords)) {
              invalidWords.push(w);
            }
          }
          if (invalidWords.length > 0) {
            warnings.push(`Variable "${varName}" in node "${nodeName}" contains spelling or non-English words: ${invalidWords.join(', ')}. (Tip: Use 'n8ncli standards allow <word>' to whitelist)`);
          }
        }
      }
    }
  }

  // 5. Connection Port validation
  const connections = workflowJson.connections || {};
  for (const [sourceName, outputsObj] of Object.entries(connections)) {
    const sourceNode = nodes.find((n: any) => n.name === sourceName);
    if (!sourceNode) continue;
    const nodeType = sourceNode.type || '';

    if (outputsObj && typeof outputsObj === 'object') {
      for (const [connType, targetGroups] of Object.entries(outputsObj as any)) {
        if (connType === 'main' && Array.isArray(targetGroups)) {
          targetGroups.forEach((targets: any, outputIndex: number) => {
            if (Array.isArray(targets) && targets.length > 0) {
              const maxAllowedOutputs = getNodeMaxAllowedOutputs(sourceNode);
              if (outputIndex >= maxAllowedOutputs) {
                if (maxAllowedOutputs === 1) {
                  warnings.push(
                    `Node "${sourceName}" [${nodeType}] is connecting from output index ${outputIndex}, but this node type only has a single main output (index 0). If you want to connect to multiple nodes in parallel, use parallel connections from output 0 (e.g. .to([target1, target2])), rather than .output(${outputIndex}).`
                  );
                } else {
                  warnings.push(
                    `Node "${sourceName}" [${nodeType}] is connecting from output index ${outputIndex}, but it only has ${maxAllowedOutputs} configured output(s) based on its structure/rules.`
                  );
                }
              }
            }
          });
        }
      }
    }
  }
  
  return { errors, warnings };
}

function renameNodeInConnections(connections: any, oldName: string, newName: string): any {
  if (!connections || typeof connections !== 'object') return connections;
  
  const updatedConnections: any = {};
  
  for (const sourceNode of Object.keys(connections)) {
    const sourceKey = sourceNode === oldName ? newName : sourceNode;
    const outputs = connections[sourceNode];
    
    if (outputs && typeof outputs === 'object') {
      const updatedOutputs: any = {};
      for (const outputType of Object.keys(outputs)) {
        const targets = outputs[outputType];
        if (Array.isArray(targets)) {
          updatedOutputs[outputType] = targets.map((targetGroup: any) => {
            if (Array.isArray(targetGroup)) {
              return targetGroup.map((target: any) => {
                if (target && typeof target === 'object' && target.node === oldName) {
                  return { ...target, node: newName };
                }
                return target;
              });
            }
            return targetGroup;
          });
        } else {
          updatedOutputs[outputType] = targets;
        }
      }
      updatedConnections[sourceKey] = updatedOutputs;
    } else {
      updatedConnections[sourceKey] = outputs;
    }
  }
  
  return updatedConnections;
}

export function fixWorkflowAgainstStandards(
  workflowJson: any,
  standards: StandardsConfig
): { modifiedJson: any; fixedCount: number } {
  let fixedCount = 0;
  const modifiedJson = JSON.parse(JSON.stringify(workflowJson));
  const nodes = modifiedJson.nodes || [];
  const format = standards.nodes?.naming?.duplicateSuffixFormat;
  const ignore = standards.ignore || {};

  // Fix workflow name casing if present
  if (modifiedJson.name) {
    const oldWfName = modifiedJson.name;
    const newWfName = toSmartTitleCase(oldWfName, standards);
    if (newWfName !== oldWfName) {
      modifiedJson.name = newWfName;
      fixedCount++;
    }
  }

  // Scaffold missing workflow description
  if (standards.workflows?.requireDescription) {
    const desc = modifiedJson.description || modifiedJson.settings?.description;
    if (!desc || desc.trim() === '') {
      if (!modifiedJson.settings) {
        modifiedJson.settings = {};
      }
      modifiedJson.settings.description = '// TODO: add description/notes';
      fixedCount++;
    }
  }
  
  if (nodes.length > 0) {
    for (const node of nodes) {
      const nodeId = node.id ? String(node.id) : '';
      const oldName = node.name || '';
      const nodeType = node.type || '';
      
      // Determine if default node name (which is tolerated if tolerateDefaultNames is true)
      const typeParts = nodeType.split('.');
      const typeBase = typeParts[typeParts.length - 1] || '';
      const defaultDisplay = typeBase
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, str => str.toUpperCase())
        .trim();
      const isDefaultName = (oldName.toLowerCase() === defaultDisplay.toLowerCase() || oldName.toLowerCase() === typeBase.toLowerCase());

      if (isIgnored(nodeId, ignore.nodes) || isIgnored(oldName, ignore.nodes) || isIgnored(nodeType, ignore.nodes)) {
        continue;
      }
      
      let newName = oldName;
      
      // 1. Suffix formatting
      if (format && !isDefaultName) {
        const parenMatch = newName.match(/^(.+)\s\((\d+)\)$/);
        const simpleMatch = newName.match(/^(.+?)(\d+)$/);
        
        if (format === 'parenthesis' && simpleMatch && !parenMatch) {
          newName = `${simpleMatch[1]} (${simpleMatch[2]})`;
        } else if (format === 'simple' && parenMatch && !simpleMatch) {
          newName = `${parenMatch[1]}${parenMatch[2]}`;
        }
      }
      
      // 2. Title casing
      if (!isDefaultName) {
        newName = toSmartTitleCase(newName, standards);
      }
      
      let nodeModified = false;
      if (newName && newName !== oldName) {
        node.name = newName;
        // Fix connections
        modifiedJson.connections = renameNodeInConnections(modifiedJson.connections, oldName, newName);
        // Fix expression references in parameters
        const exprFixed = renameNodeInExpressions(modifiedJson, oldName, newName);
        fixedCount++;
        nodeModified = true;
      }

      const isNotesIgnored = isIgnored(nodeType, standards.ignoreRules?.nodes?.notes) || isIgnored(oldName, standards.ignoreRules?.nodes?.notes);
      if (!isNotesIgnored) {
        const requireNotes = standards.nodes?.notes?.requireNotes;
        const requireNotesForTypes = standards.nodes?.notes?.requireNotesForTypes || [];
        if (requireNotes || requireNotesForTypes.includes(nodeType)) {
          const hasNote = node.notesInFlow === true && typeof node.notes === 'string' && node.notes.trim() !== '';
          if (!hasNote) {
            node.notes = '// TODO: add description/notes';
            node.notesInFlow = true;
            if (!nodeModified) {
              fixedCount++;
            }
          }
        }
      }
    }
  }

  // Fix connection port issues: merge any outputs on index > 0 into index 0 for single-output nodes
  if (modifiedJson.connections && typeof modifiedJson.connections === 'object') {
    for (const [sourceName, outputsObj] of Object.entries(modifiedJson.connections)) {
      const sourceNode = nodes.find((n: any) => n.name === sourceName);
      if (!sourceNode) continue;

      const maxAllowed = getNodeMaxAllowedOutputs(sourceNode);
      if (maxAllowed === 1 && outputsObj && typeof outputsObj === 'object') {
        const outputsCast = outputsObj as any;
        for (const connType of Object.keys(outputsCast)) {
          if (connType === 'main' && Array.isArray(outputsCast[connType])) {
            const targetGroups = outputsCast[connType];
            let needsFix = false;
            const allTargets: any[] = [];
            
            targetGroups.forEach((targets: any, outputIndex: number) => {
              if (Array.isArray(targets) && targets.length > 0) {
                allTargets.push(...targets);
                if (outputIndex > 0) {
                  needsFix = true;
                }
              }
            });

            if (needsFix) {
              outputsCast[connType] = [allTargets];
              fixedCount++;
              output.warn(`[FIX] Merged invalid connection outputs on node "${sourceName}" into a single parallel output list at index 0.`);
            }
          }
        }
      }
    }
  }
  
  return { modifiedJson, fixedCount };
}

export function validateStandardsJson(content: string): string[] {
  const errors: string[] = [];
  let json: any = null;

  try {
    json = JSON.parse(content);
  } catch (err) {
    errors.push(`Invalid JSON syntax: ${err instanceof Error ? err.message : String(err)}`);
    return errors;
  }

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    errors.push('Standards configuration must be a JSON object.');
    return errors;
  }

  const checkType = (path: string, val: any, expectedType: 'string' | 'boolean' | 'number' | 'array' | 'object') => {
    if (val === undefined) return;
    if (expectedType === 'array') {
      if (!Array.isArray(val)) {
        errors.push(`"${path}" must be an array.`);
      }
    } else if (expectedType === 'object') {
      if (typeof val !== 'object' || val === null || Array.isArray(val)) {
        errors.push(`"${path}" must be an object.`);
      }
    } else {
      if (typeof val !== expectedType) {
        errors.push(`"${path}" must be a ${expectedType}.`);
      }
    }
  };

  const validateRegex = (path: string, pattern: any) => {
    if (pattern === undefined) return;
    if (typeof pattern !== 'string') {
      errors.push(`"${path}" must be a string regular expression.`);
      return;
    }
    try {
      new RegExp(pattern);
    } catch (e) {
      errors.push(`"${path}" has invalid regular expression pattern: ${pattern}. Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // 1. Folders
  checkType('folders', json.folders, 'object');
  if (json.folders) {
    checkType('folders.naming', json.folders.naming, 'object');
    if (json.folders.naming) {
      validateRegex('folders.naming.regex', json.folders.naming.regex);
      checkType('folders.naming.errorMessage', json.folders.naming.errorMessage, 'string');
    }
  }

  // 2. Workflows
  checkType('workflows', json.workflows, 'object');
  if (json.workflows) {
    checkType('workflows.naming', json.workflows.naming, 'object');
    if (json.workflows.naming) {
      validateRegex('workflows.naming.regex', json.workflows.naming.regex);
      checkType('workflows.naming.errorMessage', json.workflows.naming.errorMessage, 'string');
    }
    checkType('workflows.requireDescription', json.workflows.requireDescription, 'boolean');
    checkType('workflows.requireTags', json.workflows.requireTags, 'boolean');
    checkType('workflows.minTags', json.workflows.minTags, 'number');
    checkType('workflows.bannedNames', json.workflows.bannedNames, 'array');
  }

  // 3. Nodes
  checkType('nodes', json.nodes, 'object');
  if (json.nodes) {
    checkType('nodes.naming', json.nodes.naming, 'object');
    if (json.nodes.naming) {
      checkType('nodes.naming.tolerateDefaultNames', json.nodes.naming.tolerateDefaultNames, 'boolean');
      if (json.nodes.naming.duplicateSuffixFormat !== undefined && 
          json.nodes.naming.duplicateSuffixFormat !== 'parenthesis' && 
          json.nodes.naming.duplicateSuffixFormat !== 'simple') {
        errors.push('"nodes.naming.duplicateSuffixFormat" must be one of: "parenthesis", "simple".');
      }
      validateRegex('nodes.naming.regex', json.nodes.naming.regex);
      checkType('nodes.naming.errorMessage', json.nodes.naming.errorMessage, 'string');
    }
    checkType('nodes.notes', json.nodes.notes, 'object');
    if (json.nodes.notes) {
      checkType('nodes.notes.requireNotes', json.nodes.notes.requireNotes, 'boolean');
      checkType('nodes.notes.requireNotesForTypes', json.nodes.notes.requireNotesForTypes, 'array');
      checkType('nodes.notes.errorMessage', json.nodes.notes.errorMessage, 'string');
    }
    checkType('nodes.stickyNotes', json.nodes.stickyNotes, 'object');
    if (json.nodes.stickyNotes) {
      checkType('nodes.stickyNotes.ignore', json.nodes.stickyNotes.ignore, 'boolean');
      checkType('nodes.stickyNotes.markdownValidation', json.nodes.stickyNotes.markdownValidation, 'boolean');
      checkType('nodes.stickyNotes.colors', json.nodes.stickyNotes.colors, 'object');
    }
  }

  // 4. Variables
  checkType('variables', json.variables, 'object');
  if (json.variables) {
    checkType('variables.naming', json.variables.naming, 'object');
    if (json.variables.naming) {
      if (json.variables.naming.convention !== undefined && 
          json.variables.naming.convention !== 'camelCase' && 
          json.variables.naming.convention !== 'PascalCase' && 
          json.variables.naming.convention !== 'snake_case') {
        errors.push('"variables.naming.convention" must be one of: "camelCase", "PascalCase", "snake_case".');
      }
      checkType('variables.naming.errorMessage', json.variables.naming.errorMessage, 'string');
    }
  }

  // 5. Language
  checkType('language', json.language, 'object');
  if (json.language) {
    checkType('language.enabled', json.language.enabled, 'boolean');
    checkType('language.expected', json.language.expected, 'string');
    checkType('language.checkFields', json.language.checkFields, 'array');
    checkType('language.allowedWords', json.language.allowedWords, 'array');
    checkType('language.errorMessage', json.language.errorMessage, 'string');
  }

  // 6. Ignore
  checkType('ignore', json.ignore, 'object');
  if (json.ignore) {
    checkType('ignore.workflows', json.ignore.workflows, 'array');
    checkType('ignore.folders', json.ignore.folders, 'array');
    checkType('ignore.nodes', json.ignore.nodes, 'array');
    checkType('ignore.variables', json.ignore.variables, 'array');
    checkType('ignore.words', json.ignore.words, 'array');
  }

  // 7. IgnoreRules
  checkType('ignoreRules', json.ignoreRules, 'object');
  if (json.ignoreRules) {
    checkType('ignoreRules.nodes', json.ignoreRules.nodes, 'object');
    if (json.ignoreRules.nodes) {
      checkType('ignoreRules.nodes.titleCase', json.ignoreRules.nodes.titleCase, 'array');
      checkType('ignoreRules.nodes.namingRegex', json.ignoreRules.nodes.namingRegex, 'array');
      checkType('ignoreRules.nodes.duplicateSuffix', json.ignoreRules.nodes.duplicateSuffix, 'array');
      checkType('ignoreRules.nodes.notes', json.ignoreRules.nodes.notes, 'array');
    }
  }

  return errors;
}
