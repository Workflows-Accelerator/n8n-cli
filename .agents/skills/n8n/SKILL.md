---
name: n8ncli
version: 1.2.40
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

This skill enables the AI agent to manage, sync, validate, and test n8n workflows locally in this repository using the `n8ncli` tool.

## Key Capabilities of n8ncli
- **Workflow as Code:** Sync remote workflows as TypeScript files using the official `@n8n/workflow-sdk` builder format.
- **Pure MCP-Only Mode:** Pull and sync workflows using only an instance URL and MCP access token without requiring REST API keys or direct database access.
- **Local Validation:** Validate workflows locally using schemas without roundtrips to the n8n instance.
- **Git-friendly Sync:** Pull remote workflows, inspect local modifications, and push changes with conflict detection.
- **Database-Backed Folder Synchronization:** Sync local folders and categories directly to the remote n8n PostgreSQL database on push.
- **Testing & Execution:** Run manual/production executions or local test runs with auto-mocked pin data.

---

## Command Reference

### Configuration & Discovery
- `n8ncli environments` / `n8ncli env`: Manage n8n environment configurations.
  - `n8ncli env list`: List configured environments.
  - `n8ncli env test [name]`: Test REST API, MCP, and PostgreSQL DB connections (reports SKIPPED for unconfigured optional services).
  - `n8ncli env edit <name>`: Configure environment details interactively (defaults MCP command automatically) or via flags.
  - `n8ncli env delete <name>`: Delete an environment configuration.
- `n8ncli init [--include-examples|--no-examples] [--reset]`: Initialize workspace config. Includes built-in reference workflow examples by default. Use `--reset` to reset standards and layout configurations and delete local caches.
- `n8ncli projects`: List accessible projects.
- `n8ncli folders`: List and manage folders in an n8n project.
  - `n8ncli folders list [--recursive] [--tree] [--parent-folder-id <id>] [--json]`: List folders under the project. Supports visual tree or recursive view and parent folder filtering.
  - `n8ncli folders create <name>`: Create a new folder directly in the database.
  - `n8ncli folders move <workflow-id-or-path> <folder-id-or-name>`: Move a workflow to a specific folder in the database.
  - `n8ncli folders delete <folder-id-or-name> [--no-cascade] [--dry-run]`: Delete a folder from the database (supporting dry-run protection).
  - `n8ncli folders set-parent <folder-id-or-name> <parent-folder-id-or-name> [--dry-run]`: Set parent folder for a folder in the database (logs previous parent, supports dry-run protection).
- `n8ncli lint [--fix] [--upgrade-nodes] [--only-modified] [--fail-on-warnings]`: Enforce style standards, auto-correct duplicate node names and connection mapping, and optionally auto-upgrade node versions to latest. Exit code 2 is only triggered on warnings if --fail-on-warnings is specified.

### Syncing
- `n8ncli pull [target] [--force] [--hard] [--dry-run]`: Pull workflows from n8n instance and sync folder metadata (supports pure MCP-only workflows without REST API key or DB; specify target workflow file, ID, or folder path), or simulate the pull without writing to disk.
- `n8ncli push [target] [--all] [--no-cache] [--force] [--prune] [--dry-run]`: Deploy local modifications and folder structures (specify target workflow file, ID, or folder path; use `--no-cache` to force clean builds across workflows; use `--prune` to purge remote database duplicates).
- `n8ncli live [--interval <seconds>] [--ttl <minutes>] [--stop] [--status] [--foreground]`: Start, stop, or inspect the live synchronization background daemon.
- `n8ncli status`: List modified, untracked, deleted, or remote-only files.
- `n8ncli diff [target] [--all] [--summary] [--semantic] [--json]`: Show code differences between local workflow files and remote n8n versions (specify target workflow file, ID, or folder path; use `--semantic` to ignore coordinate/position differences).

### Verification, Debugging & Testing
- `n8ncli validate [files...] [--lint] [--upgrade-nodes] [--fix] [--only-modified] [--fail-on-warnings]`: Validate syntax, schema, node versions, expression node references, and style standards. Use `--upgrade-nodes` or `--fix` to automatically bump nodes to their latest typeVersion. Exit code 2 is triggered on warnings if --fail-on-warnings is specified.
- `n8ncli exec <file-or-id> [--mode manual|production] [--input <json-or-file>]`: Execute workflow.
- `n8ncli test <file-or-id> [--pin-data <file>]`: Test run with mock pin data.
- `n8ncli execution <file-or-id> <execution-id> [--include-data] [--node <name>]`: Inspect execution details. Specify --include-data to output raw JSON node input/output payload.
- `n8ncli execution inspect <file-or-id-or-execution-id>`: Inspect detailed stack traces, failed node inputs/outputs, and error payloads for an execution.
- `n8ncli logs [workflow-id-or-file] [--limit <n>] [--failed-only] [--last-failed] [--db-url <url>]`: Fetch and format recent execution logs and failure stack traces for a workflow (use `--last-failed` for immediate failure diagnostics).
- `n8ncli webhooks verify [--db-url <url>]`: Audit active webhook routes registered in `webhook_entity` against active workflow trigger definitions in `workflow_entity`.
- `n8ncli debug <executionId> [--db-url <url>]`: Directly inspect and format error stack trace, failing node parameters, and payload data for a specific execution ID.
- `n8ncli layout [files...] [--nodesep <px>] [--ranksep <px>] [--grid <px>] [--no-align-terminal-nodes] [--subnode-sep <px>] [--subnode-horizontal-sep <px>] [--alignment <mode>] [--dry-run]`: Auto-position nodes in n8n workflows using Dagre.

### Database Datatables
- `n8ncli datatables`: Inspect and update n8n database tracking datatables.
  - `n8ncli datatables list`: List user tables in the database.
  - `n8ncli datatables query <table-name> [--filter <filter>] [--limit <n>]`: Query rows from a table.
  - `n8ncli datatables update <table-name> --data <json> [--filter <filter>]`: Update rows in a table.

### Publishing & Nodes
- `n8ncli publish <file-or-id>`: Activate a workflow for production triggers.
- `n8ncli unpublish <file-or-id>`: Deactivate a workflow.
- `n8ncli nodes search <queries...>`: Search available node types (e.g. `gmail`, `slack`).
- `n8ncli nodes types <nodeIds...>`: View exact TypeScript parameters and interfaces for nodes (supports colon syntax e.g. `n8n-nodes-base.gmail:message:send` for operation-specific types).
- `n8ncli nodes doc <nodeId>`: Get interactive documentation, copy-pasteable TypeScript SDK code examples, parameter details, and raw types.
- `n8ncli sdk [section-or-query]`: View workflow SDK guidelines, expressions, patterns, and rules, or search case-insensitively for a keyword.

---

## Workflow Development Lifecycle for AI Agents

Follow these steps when creating, editing, or managing workflows:

1. **Pull Latest Workflows:**
   Ensure your local state is up to date:
   ```bash
   n8ncli pull
   ```
2. **Explore References & SDK:**
   Consult the SDK references and existing patterns:
   ```bash
   n8ncli sdk all
   ```
   Look at `n8n/references/` for workflow examples.
3. **Inspect Node Schemas & Docs:**
   When adding a new node, search for its type, and get interactive documentation and copy-pasteable SDK examples:
   ```bash
   n8ncli nodes search gmail
   n8ncli nodes doc n8n-nodes-base.gmail:message:send
   ```
4. **Develop / Modify:**
   Workflows are stored under `n8n/workflows/`.
   - Prefer modifying the TypeScript files (`*.workflow.ts`) using the builder SDK.
   - If you write standard workflow JSON, save it as `*.json`. The CLI automatically converts it to TypeScript during pull, push, or validate.
5. **Local Validation:**
   Check your changes for syntax, schema, and style standards before pushing:
   ```bash
   n8ncli validate --lint
   ```
6. **Push & Deploy:**
   Sync your local code back to the remote n8n instance:
   ```bash
   n8ncli push
   ```
7. **Verify Execution:**
   Test-run your workflow to make sure it works as expected:
   ```bash
   n8ncli test <file-or-id>
   ```
8. **Publish:**
   Once verified, activate the workflow for production triggers:
   ```bash
   n8ncli publish <file-or-id>
   ```

---

## Programmatic & Automation Tips

- **Structured Output:** Run commands with the `--json` flag (e.g., `n8ncli status --json`) to get structured JSON outputs on stdout.
- **Exit Codes:**
  - `0`: Success
  - `1`: Error (execution/connection)
  - `2`: Validation or standards check failed
  - `3`: Sync conflict (requires manual merge/resolution)
- **Config Overrides:** Run commands anywhere by passing `--config /path/to/n8n-cli.json`.

---

## ⚠️ Key Caveats & Gotchas

- **File Renaming on Pull:** The `pull` command uses each workflow's remote display name as its filename (e.g., `My Workflow.workflow.ts`). Local files using kebab-case or other naming structures will be renamed on pull. Avoid relying on custom local filenames.
- **Node Notes & notesInFlow Placement:** In the TypeScript SDK, node-level descriptions/notes and the `notesInFlow` flag must be placed inside the `.config()` block of the node, **not** as top-level node arguments or inside parameters. See the example below.
- **Inline Ignore Comments:** To prevent a workflow from being synced on push, validated, or linted, add a comment like `// n8ncli-ignore` or `// n8ncli-push-ignore` at the top (within the first 10 lines) of the workflow file.
- **TS SDK expr(...) AST Parsing Restriction:** When building dynamic strings or SQL queries inside `expr(...)`, concatenating JS identifiers outside quotes like `expr('SELECT ... ' + ($('Inputs').item...))` causes AST compilation errors (`Unknown identifier: '$' is not defined`). Expressions must be kept strictly inside n8n template braces inside the string literal: `expr('SELECT ... {{ $(\'Inputs\').item.json.id ? ... : ... }}')`.

---

## 💡 Code Examples

### 1. Minimal Valid Workflow
```typescript
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
```

### 2. Webhook Trigger Naming Convention
Webhook triggers MUST follow the naming convention `[METHOD] /[endpoint]`:
```typescript
node('POST /submit-lead', 'n8n-nodes-base.webhook')
  .position(100, 200)
  .parameters({
    httpMethod: 'POST',
    path: 'submit-lead',
    responseMode: 'onReceived'
  })
```

### 3. Switch Nodes and Multi-Branch Routing
For Switch nodes, use `onCase(index, targetNode)` where `index` is a 0-based routing output index matching the order of configured rules:
```typescript
import { workflow, node, switchCase } from '@n8n/workflow-sdk';

const startTrigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Start' }
});

const routeByStatus = switchCase({
  version: 3.2,
  config: {
    name: 'Route by Status',
    parameters: {
      rules: {
        values: [
          { outputKey: 'active', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.status }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'active' }], combinator: 'and' } },
          { outputKey: 'pending', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.status }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'pending' }], combinator: 'and' } }
        ]
      }
    }
  }
});

const activeHandler = node({ type: 'n8n-nodes-base.noOp', version: 1, config: { name: 'Active Handler' } });
const pendingHandler = node({ type: 'n8n-nodes-base.noOp', version: 1, config: { name: 'Pending Handler' } });
const fallbackHandler = node({ type: 'n8n-nodes-base.noOp', version: 1, config: { name: 'Fallback Handler' } });

export default workflow('switch-workflow', 'Switch Workflow')
  .add(startTrigger)
  .to(routeByStatus
    .onCase(0, activeHandler)
    .onCase(1, pendingHandler)
    .onCase(2, fallbackHandler)
  );
```

### 4. Parallel Connections (One-to-Many Outputs)
To branch out into parallel streams from a single-output node (like HTTP Request, Trigger, Code, etc.), connect to an array of nodes using `.to([target1, target2])`. Do NOT call `.output(1)` or `.onCase()` as they are invalid on single-output nodes:
```typescript
import { workflow, node, merge } from '@n8n/workflow-sdk';

const startTrigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Start' }
});

const processA = node({ type: 'n8n-nodes-base.noOp', version: 1, config: { name: 'Process A' } });
const processB = node({ type: 'n8n-nodes-base.noOp', version: 1, config: { name: 'Process B' } });

const combineResults = merge({
  version: 3.2,
  config: { name: 'Combine Results', parameters: { mode: 'combine' } }
});

const finalStep = node({ type: 'n8n-nodes-base.noOp', version: 1, config: { name: 'Final Step' } });

export default workflow('parallel-workflow', 'Parallel Workflow')
  .add(startTrigger
    .to([
      processA,
      processB
    ])
  )
  .add(processA.to(combineResults.input(0)))
  .add(processB.to(combineResults.input(1)))
  .add(combineResults)
  .to(finalStep);
```

### 5. Code Nodes with Notes
Code nodes require descriptive notes. Ensure `notes` and `notesInFlow` are placed inside the `.config()` block of the node:
```typescript
import { workflow, node } from '@n8n/workflow-sdk';

const startTrigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Start' }
});

const processCode = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Process Data Code',
    notes: 'Processes input values and sums up the total processed value.',
    notesInFlow: true
  },
  parameters: {
    jsCode: 'return $input.all().map(item => ({ json: { val: item.json.val * 2 } }));'
  }
});

export default workflow('code-workflow', 'Code Workflow')
  .add(startTrigger)
  .to(processCode);
```

---

## Project Standards & Naming Conventions

This project enforces strict style standards configured in `n8n-standards.json`. AI agents MUST adhere to these rules when creating or modifying workflows:

- **Folders:** Directory names must match: `^[A-Z][a-zA-Z0-9\s()-]*$`. (Folder names must be in Title Case (starting with uppercase) and can contain letters, numbers, spaces, dashes, or parentheses.)
- **Workflows:** Workflow names must match: `^[A-Z][a-zA-Z0-9\s()-]*$`. (Workflow names must be in Title Case (starting with uppercase) and can contain letters, numbers, spaces, dashes, or parentheses.)
- **Workflow Naming Restrictions:** Default/banned names like "My workflow", "New workflow", "Workflow", "Untitled workflow" (and numbered variations like "My workflow 1") are strictly forbidden.
- **Workflow Description:** Every workflow MUST have a non-empty description explaining its purpose.
- **Nodes:** Node names must match: `^[A-Z][a-zA-Z0-9\s()\-:/]*$`. (Node names must be in Title Case (starting with uppercase) and can contain letters, numbers, spaces, dashes, parentheses, colons, or forward slashes.)
  - *Exception:* Default node names (like "Set", "HTTP Request") are tolerated if they are the only nodes of their type in the workflow.
- **Duplicate Node Naming:** Must follow the `parenthesis` numbering format (e.g. "My Node (1)").
- **Node Notes:** Notes are required on the following node types: `n8n-nodes-base.code`.
- **Variables:** Variables declared inside Set or Edit Fields nodes must follow: `camelCase`.
- **Language:** Enforce English (`en`) language check on: `workflow.description, node.notes, node.name, variable.name`.
- **Sticky Notes:** Validated for Markdown syntax.
  - **Color Guidelines (for documentation context):**
    - Red (Color Code `1`): Mark areas/logic needing fixes.
    - Blue (Color Code `2`): Design specifications or expected behaviors.
    - Green (Color Code `3`): Ideas or future improvements.
    - Purple (Color Code `4`): Needs review/help from a team member.

### Ignores & Exceptions
- **Tolerated/Ignored Words:** `sub-workflows, itemId, sub-workflow, defineBelow, executeOnce, high-value, Category-based, low-value, Re-converges, Metadata, high-level, metadata, responseId, embeddings, pgvector, PostgreSQL, retrieval-augmented, LLM, SaaS, backend, LangChain`
