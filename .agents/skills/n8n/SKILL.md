---
name: n8ncli
version: 1.0.8
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
- **Local Validation:** Validate workflows locally using schemas without roundtrips to the n8n instance.
- **Git-friendly Sync:** Pull remote workflows, inspect local modifications, and push changes with conflict detection.
- **Database-Backed Folder Synchronization:** Sync local folders and categories directly to the remote n8n PostgreSQL database on push.
- **Testing & Execution:** Run manual/production executions or local test runs with auto-mocked pin data.

---

## Command Reference

### Configuration & Discovery
- `n8ncli environments` / `n8ncli envs`: List configured environments.
- `n8ncli init`: Initialize workspace config (creates `n8n/config/n8n-cli.json`).
- `n8ncli projects`: List accessible projects.
- `n8ncli folders`: List folders under the project.
- `n8ncli lint [--fix]`: Enforce style standards, and auto-correct duplicate node names and connection mapping.

### Syncing
- `n8ncli pull [--force] [--hard] [--dry-run]`: Pull workflows from n8n instance and sync folder metadata, or simulate the pull without writing to disk.
- `n8ncli push [--force] [--dry-run]`: Deploy local modifications and folder structures.
- `n8ncli status`: List modified, untracked, deleted, or remote-only files.
- `n8ncli diff <file> [--semantic]`: Show line diff of a local file against remote (use `--semantic` to ignore node coordinate/position differences).

### Verification & Testing
- `n8ncli validate [files...] [--lint]`: Validate syntax, schema, and node versions (and optionally standards style checks).
- `n8ncli exec <file-or-id> [--mode manual|production] [--input <json-or-file>]`: Execute workflow.
- `n8ncli test <file-or-id> [--pin-data <file>]`: Test run with mock pin data.
- `n8ncli execution <file-or-id> <execution-id> [--include-data]`: Inspect execution details.

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
