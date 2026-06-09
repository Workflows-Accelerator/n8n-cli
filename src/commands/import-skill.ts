import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { findRepoRoot } from '../config.js';
import * as output from '../output.js';
import { loadStandards, StandardsConfig } from '../lint-engine.js';

export function generateStandardsSkillSection(standards: StandardsConfig): string {
  let section = `
---

## Project Standards & Naming Conventions

This project enforces strict style standards configured in \`n8n-standards.json\`. AI agents MUST adhere to these rules when creating or modifying workflows:

`;

  if (standards.folders?.naming?.regex) {
    section += `- **Folders:** Directory names must match: \`${standards.folders.naming.regex}\`. (${standards.folders.naming.errorMessage || ''})\n`;
  }
  if (standards.workflows?.naming?.regex) {
    section += `- **Workflows:** Workflow names must match: \`${standards.workflows.naming.regex}\`. (${standards.workflows.naming.errorMessage || ''})\n`;
  }
  section += `- **Workflow Naming Restrictions:** Default/banned names like "My workflow", "New workflow", "Workflow", "Untitled workflow" (and numbered variations like "My workflow 1") are strictly forbidden.\n`;
  if (standards.workflows?.requireDescription) {
    section += `- **Workflow Description:** Every workflow MUST have a non-empty description explaining its purpose.\n`;
  }
  if (standards.nodes?.naming?.regex) {
    section += `- **Nodes:** Node names must match: \`${standards.nodes.naming.regex}\`. (${standards.nodes.naming.errorMessage || ''})\n`;
    if (standards.nodes.naming.tolerateDefaultNames) {
      section += `  - *Exception:* Default node names (like "Set", "HTTP Request") are tolerated if they are the only nodes of their type in the workflow.\n`;
    } else {
      section += `  - **Default Names Banned:** Default node names (like "Set", "HTTP Request") are strictly forbidden. Every node must have a descriptive, custom name.\n`;
    }
  }
  if (standards.nodes?.naming?.duplicateSuffixFormat) {
    const format = standards.nodes.naming.duplicateSuffixFormat;
    const example = format === 'parenthesis' ? '"My Node (1)"' : '"My Node1"';
    section += `- **Duplicate Node Naming:** Must follow the \`${format}\` numbering format (e.g. ${example}).\n`;
  }
  if (standards.nodes?.notes?.requireNotes) {
    section += `- **Node Notes:** All nodes require descriptive notes.\n`;
  } else if (standards.nodes?.notes?.requireNotesForTypes && standards.nodes.notes.requireNotesForTypes.length > 0) {
    section += `- **Node Notes:** Notes are required on the following node types: \`${standards.nodes.notes.requireNotesForTypes.join(', ')}\`.\n`;
  }
  if (standards.variables?.naming?.convention) {
    section += `- **Variables:** Variables declared inside Set or Edit Fields nodes must follow: \`${standards.variables.naming.convention}\`.\n`;
  }
  if (standards.language?.enabled) {
    section += `- **Language:** Enforce English (\`${standards.language.expected || 'en'}\`) language check on: \`${(standards.language.checkFields || []).join(', ')}\`.\n`;
  }
  if (standards.nodes?.stickyNotes) {
    const sticky = standards.nodes.stickyNotes;
    if (sticky.ignore) {
      section += `- **Sticky Notes:** Ignored from lint/style checks.\n`;
    } else {
      section += `- **Sticky Notes:** Validated for Markdown syntax.\n`;
      if (sticky.colors) {
        section += `  - **Color Guidelines (for documentation context):**\n`;
        if (sticky.colors.needFixing !== undefined) {
          section += `    - Red (Color Code \`${sticky.colors.needFixing}\`): Mark areas/logic needing fixes.\n`;
        }
        if (sticky.colors.specs !== undefined) {
          section += `    - Blue (Color Code \`${sticky.colors.specs}\`): Design specifications or expected behaviors.\n`;
        }
        if (sticky.colors.futureImprovements !== undefined) {
          section += `    - Green (Color Code \`${sticky.colors.futureImprovements}\`): Ideas or future improvements.\n`;
        }
        if (sticky.colors.needsHumanHelp !== undefined) {
          section += `    - Purple (Color Code \`${sticky.colors.needsHumanHelp}\`): Needs review/help from a team member.\n`;
        }
      }
    }
  }

  const ignore = standards.ignore || {};
  const hasIgnores = (ignore.workflows && ignore.workflows.length > 0) ||
                     (ignore.folders && ignore.folders.length > 0) ||
                     (ignore.nodes && ignore.nodes.length > 0) ||
                     (ignore.variables && ignore.variables.length > 0) ||
                     (ignore.words && ignore.words.length > 0);

  if (hasIgnores) {
    section += `\n### Ignores & Exceptions\n`;
    if (ignore.workflows && ignore.workflows.length > 0) {
      section += `- **Ignored Workflows (by ID or Path):** \`${ignore.workflows.join(', ')}\`\n`;
    }
    if (ignore.folders && ignore.folders.length > 0) {
      section += `- **Ignored Folders (by ID or Path):** \`${ignore.folders.join(', ')}\`\n`;
    }
    if (ignore.nodes && ignore.nodes.length > 0) {
      section += `- **Ignored Nodes (by ID, Name, or Type):** \`${ignore.nodes.join(', ')}\`\n`;
    }
    if (ignore.variables && ignore.variables.length > 0) {
      section += `- **Ignored Variables:** \`${ignore.variables.join(', ')}\`\n`;
    }
    if (ignore.words && ignore.words.length > 0) {
      section += `- **Tolerated/Ignored Words:** \`${ignore.words.join(', ')}\`\n`;
    }
  }

  return section;
}

export function getSkillContent(standards: StandardsConfig, repoRoot?: string): string {
  let version = '1.0.0';
  if (repoRoot) {
    try {
      const pkgPath = path.join(repoRoot, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.version) {
          version = pkg.version;
        }
      }
    } catch {
      // fallback
    }
  }

  let content = `---
name: n8ncli
version: ${version}
description: |
  Manage, sync, validate, and test n8n workflows locally in this repository using the n8ncli tool.
  Supports workflow-as-code syncing, local schema validation, testing/execution, and standards checking.
license: ISC
compatibility: claude-code opencode
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Skill: Managing n8n Workflows with n8ncli

This skill enables the AI agent to manage, sync, validate, and test n8n workflows locally in this repository using the \`n8ncli\` tool.

## Key Capabilities of n8ncli
- **Workflow as Code:** Sync remote workflows as TypeScript files using the official \`@n8n/workflow-sdk\` builder format.
- **Local Validation:** Validate workflows locally using schemas without roundtrips to the n8n instance.
- **Git-friendly Sync:** Pull remote workflows, inspect local modifications, and push changes with conflict detection.
- **Database-Backed Folder Synchronization:** Sync local folders and categories directly to the remote n8n PostgreSQL database on push.
- **Testing & Execution:** Run manual/production executions or local test runs with auto-mocked pin data.

---

## Command Reference

### Configuration & Discovery
- \`n8ncli environments\` / \`n8ncli envs\`: List configured environments.
- \`n8ncli init\`: Initialize workspace config (creates \`n8n/config/n8n-cli.json\`).
- \`n8ncli projects\`: List accessible projects.
- \`n8ncli folders\`: List folders under the project.
- \`n8ncli lint [--fix]\`: Enforce style standards, and auto-correct duplicate node names and connection mapping.

### Syncing
- \`n8ncli pull [--force] [--hard]\`: Pull workflows from n8n instance and sync folder metadata.
- \`n8ncli push [--force] [--dry-run]\`: Deploy local modifications and folder structures.
- \`n8ncli status\`: List modified, untracked, or deleted files.
- \`n8ncli diff <file>\`: Show line diff of a local file against remote.

### Verification & Testing
- \`n8ncli validate [files...] [--lint]\`: Validate syntax, schema, and node versions (and optionally standards style checks).
- \`n8ncli exec <file-or-id> [--mode manual|production] [--input <json-or-file>]\`: Execute workflow.
- \`n8ncli test <file-or-id> [--pin-data <file>]\`: Test run with mock pin data.
- \`n8ncli execution <file-or-id> <execution-id> [--include-data]\`: Inspect execution details.

### Publishing & Nodes
- \`n8ncli publish <file-or-id>\`: Activate a workflow for production triggers.
- \`n8ncli unpublish <file-or-id>\`: Deactivate a workflow.
- \`n8ncli nodes search <queries...>\`: Search available node types (e.g. \`gmail\`, \`slack\`).
- \`n8ncli nodes types <nodeIds...>\`: View exact TypeScript parameters and interfaces for nodes.
- \`n8ncli sdk [section]\`: View workflow SDK guidelines, expressions, patterns, and rules.

---

## Workflow Development Lifecycle for AI Agents

Follow these steps when creating, editing, or managing workflows:

1. **Pull Latest Workflows:**
   Ensure your local state is up to date:
   \`\`\`bash
   n8ncli pull
   \`\`\`
2. **Explore References & SDK:**
   Consult the SDK references and existing patterns:
   \`\`\`bash
   n8ncli sdk all
   \`\`\`
   Look at \`n8n/references/\` for workflow examples.
3. **Inspect Node Schemas:**
   When adding a new node, search for its type and view its exact TypeScript interface:
   \`\`\`bash
   n8ncli nodes search gmail
   n8ncli nodes types n8n-nodes-base.gmail
   \`\`\`
4. **Develop / Modify:**
   Workflows are stored under \`n8n/workflows/\`.
   - Prefer modifying the TypeScript files (\`*.workflow.ts\`) using the builder SDK.
   - If you write standard workflow JSON, save it as \`*.json\`. The CLI automatically converts it to TypeScript during pull, push, or validate.
5. **Local Validation:**
   Check your changes for syntax, schema, and style standards before pushing:
   \`\`\`bash
   n8ncli validate --lint
   \`\`\`
6. **Push & Deploy:**
   Sync your local code back to the remote n8n instance:
   \`\`\`bash
   n8ncli push
   \`\`\`
7. **Verify Execution:**
   Test-run your workflow to make sure it works as expected:
   \`\`\`bash
   n8ncli test <file-or-id>
   \`\`\`
8. **Publish:**
   Once verified, activate the workflow for production triggers:
   \`\`\`bash
   n8ncli publish <file-or-id>
   \`\`\`

---

## Programmatic & Automation Tips

- **Structured Output:** Run commands with the \`--json\` flag (e.g., \`n8ncli status --json\`) to get structured JSON outputs on stdout.
- **Exit Codes:**
  - \`0\`: Success
  - \`1\`: Error (execution/connection)
  - \`2\`: Validation or standards check failed
  - \`3\`: Sync conflict (requires manual merge/resolution)
- **Config Overrides:** Run commands anywhere by passing \`--config /path/to/n8n-cli.json\`.

---

## ⚠️ Key Caveats & Gotchas

- **File Renaming on Pull:** The \`pull\` command uses each workflow's remote display name as its filename (e.g., \`My Workflow.workflow.ts\`). Local files using kebab-case or other naming structures will be renamed on pull. Avoid relying on custom local filenames.
- **Node Notes & notesInFlow Placement:** In the TypeScript SDK, node-level descriptions/notes and the \`notesInFlow\` flag must be placed inside the \`.config()\` block of the node, **not** as top-level node arguments or inside parameters. See the example below.

---

## 💡 Code Examples

### 1. Minimal Valid Workflow
\`\`\`typescript
import { workflow, node } from '@n8n/workflow-sdk';

export default workflow('My New Workflow')
  .description('This workflow performs a daily backup check.')
  .addNode(
    node('Schedule Trigger', 'n8n-nodes-base.scheduleTrigger')
      .position(100, 200)
  )
  .addNode(
    node('Log Status', 'n8n-nodes-base.code')
      .position(300, 200)
      .config({
        notes: 'Processes the schedule event and logs a status message.',
        notesInFlow: true
      })
      .parameters({
        jsCode: 'return { json: { status: "OK", time: new Date() } };'
      })
  )
  .connect('Schedule Trigger', 'Log Status');
\`\`\`

### 2. Webhook Trigger Naming Convention
Webhook triggers MUST follow the naming convention \`[METHOD] /[endpoint]\`:
\`\`\`typescript
node('POST /submit-lead', 'n8n-nodes-base.webhook')
  .position(100, 200)
  .parameters({
    httpMethod: 'POST',
    path: 'submit-lead',
    responseMode: 'onReceived'
  })
\`\`\`
`;

  content += generateStandardsSkillSection(standards);
  return content;
}

export function writeSkillFile(repoRoot: string, targetDir = '.agents/skills/n8n', filename = 'SKILL.md'): string {
  const fullDir = path.resolve(repoRoot, targetDir);
  if (!fs.existsSync(fullDir)) {
    fs.mkdirSync(fullDir, { recursive: true });
  }
  const fullPath = path.join(fullDir, filename);
  const standards = loadStandards(repoRoot);
  fs.writeFileSync(fullPath, getSkillContent(standards, repoRoot), 'utf-8');
  return path.relative(repoRoot, fullPath).replace(/\\/g, '/');
}

export function importSkillCommand(program: Command) {
  program
    .command('import-skill')
    .description('Import the n8n CLI skill file for AI agents')
    .option('--dir <path>', 'directory to write the skill file to', '.agents/skills/n8n')
    .option('--filename <name>', 'filename of the skill file', 'SKILL.md')
    .action((options) => {
      try {
        const repoRoot = findRepoRoot() || process.cwd();
        const relativePath = writeSkillFile(repoRoot, options.dir, options.filename);
        output.log(`Successfully imported n8n CLI skill to: ${relativePath}`);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
