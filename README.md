# n8ncli — AI-First n8n Workflow CLI

An optimized TypeScript CLI tool that wraps n8n MCP server tools into fast, token-efficient, and deterministic commands. It eliminates MCP server roundtrips and allows developers (and AI agents) to manage n8n workflows as local TypeScript SDK code, perform local validation, and synchronize with an n8n instance.

## Key Features

- **Workflow as Code:** Sync workflows as TypeScript files using the official `@n8n/workflow-sdk` builder format. Supports automatic conversion of local `.json` workflow files to `.workflow.ts`.
- **Database-Backed Folder Synchronization**: Directly syncs folder structures to the remote PostgreSQL database on `push` (supporting creates, moves/renames, and deletions of empty folders), with retention safety rules on `pull`.
- **Multi-Environment Management**: Configures and switches between multiple environments (e.g. `PARRIS`) defined machine-wide in `~/.n8ncli-global.json`.
- **Fast Local Validation:** Validate workflows locally using schema checkers without connecting to the n8n instance.
- **Git-friendly Sync:** Pull remote workflows (`pull`), inspect modifications (`status` and `diff`), and push changes (`push`) with built-in conflict detection.
- **Curated References Library:** Automatically pull and cache workflows from a designated reference project to help AI agents learn patterns and reuse components.
- **No-Overhead Execution & Testing:** Run manual/production executions (`exec`) or run local mock test runs (`test`) with automatically generated pin data schemas.

---

## Installation

Install dependencies and build the package:

```bash
# In the n8n-cli directory
npm install
npm run build
```

Link the CLI globally to use `n8ncli` anywhere:

```bash
npm link
```

---

## Quick Start

### 1. Discover Projects
To discover the project ID to sync with:
```bash
n8ncli projects --access-token <your-n8n-token>
```

### 2. Initialize the Project
Initialize the configuration in your target repository root:
```bash
n8ncli init \
  --url https://your-n8n-instance.com \
  --access-token <your-token> \
  --project-id <your-project-id> \
  --ref-project-id <optional-reference-project-id> \
  --db-url <optional-postgresql-db-url> \
  --env PARRIS
```
This command creates:
- `n8n/config/n8n-cli.json` (sync settings pointing to the `PARRIS` environment)
- `n8n/workflows/` (your workflow code files)
- `n8n/references/` (reference workflows cache)
- Configures `.gitignore` to keep credentials and local sync cache out of version control.
- Saves connection credentials globally under the `PARRIS` key inside `~/.n8ncli-global.json`.

### 3. Pull Workflows
Download remote workflows and convert them to TypeScript:
```bash
n8ncli pull
```

### 4. Check status
See modified, untracked, or deleted files:
```bash
n8ncli status
```

### 5. Push Changes
Deploy your local TypeScript workflow code modifications and folder structures back to the n8n instance:
```bash
n8ncli push
```

---

## Command Reference

### Scaffolding & Configuration
- `n8ncli init`: Setup configuration, `.gitignore`, and `.env` credentials. Saves credentials globally.
- `n8ncli projects`: List all projects and their IDs.
- `n8ncli folders`: List all folders under a project.

### Syncing
- `n8ncli pull [--force] [--hard] [--skip-references] [--db-url <url>]`: Pull workflows from n8n instance and sync folder metadata.
- `n8ncli push [--force] [--dry-run] [--db-url <url>]`: Deploy local modifications and synchronize directory structures.
- `n8ncli status`: List modified/untracked/deleted files.
- `n8ncli diff <file>`: Show unified line diff of a local file against remote.

### Verification & Execution
- `n8ncli validate [files...]`: Validate TS code syntax and schema correctness.
- `n8ncli exec <file-or-id> [--mode manual|production] [--input <json-or-file>]`: Run a workflow.
- `n8ncli test <file-or-id> [--pin-data <file>]`: Test run using custom or auto-mocked pin data.
- `n8ncli execution <file-or-id> <execution-id> [--include-data]`: Get detailed status/metadata.

### Publishing
- `n8ncli publish <file-or-id>`: Activate a workflow for production triggers.
- `n8ncli unpublish <file-or-id>`: Deactivate a workflow.

### Reference & Discovery
- `n8ncli sdk [section]`: Fetch SDK reference documentation (sections: patterns, expressions, functions, rules, import, guidelines, design).
- `n8ncli nodes search <queries...>`: Search available node types (e.g. `gmail`, `slack`, `code`).
- `n8ncli nodes types <nodeIds...>`: View exact TS schemas and properties for nodes.
- `n8ncli nodes suggest <categories...>`: View recommended nodes (categories: chatbot, data_transformation, etc.).

---

## AI Agent Integration Guidelines

When using an AI coder (like Antigravity or Claude Code) inside a repo managed by `n8ncli`, the agent does **not** need the n8n-mcp server anymore. Instead, the agent should follow this lifecycle:

1. **Discover Patterns:** Read `n8n/references/index.yaml` to find reference workflows and load relevant `.workflow.ts` files to copy code structures.
2. **Consult Reference:** Run `n8ncli sdk all` to read SDK syntax, rules, and rules for expressions.
3. **Discover Node Types:** Run `n8ncli nodes types n8n-nodes-base.gmail` to view exact parameter interfaces for the nodes they wish to add.
4. **Develop & Validate:** Edit local workflow files (written as `.json` or `.workflow.ts` files) and run `n8ncli validate` to check for syntax and schema issues locally (milliseconds instead of slow MCP validation roundtrips).
5. **Sync & Publish:** Run `n8ncli push` to deploy, then `n8ncli publish <file>` to activate.

### Programmatic & Multi-Tenant VPS Usage

If running under an automated agent inside a remote VPS hosting multiple clients/instances, the CLI provides several features for robust integration:

- **Explicit Config Overrides (`--config <path>`)**: Skip process working directory scanning and specify the config path directly. Useful in multi-tenant environments where commands might run outside the workspace directory.
  ```bash
  n8ncli --config /path/to/n8n-cli.json status
  ```
- **Structured JSON Mode (`--json`)**: Add the global `--json` flag to receive structured JSON objects on `stdout` instead of human-friendly tables or console logs. Supported on `status`, `validate`, `projects`, and `folders`.
  ```bash
  n8ncli status --json
  ```
- **Differentiated Exit Codes**:
  - `0`: Success.
  - `1`: General execution or connection failure.
  - `2`: Validation check failure (e.g. `validate` failed).
  - `3`: Synchronization Conflict (e.g. `pull` or `push` skipped due to local/remote diverged states). Use this to trigger automated merge resolutions.

