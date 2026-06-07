# `n8ncli` Technical Specifications

`n8ncli` is an AI-first, token-efficient command-line interface wrapping n8n Model Context Protocol (MCP) server tools. It enables standard TypeScript-based workflow synchronization, validation, execution, and reference material ingestion for local development.

---

## 1. Environment & Configuration

`n8ncli` manages configuration at both the local project level and the machine-wide global level, alongside environment variables for secrets.

### 1.1 Local Configuration
**Path:** `n8n/config/n8n-cli.json` (Committed)
Stores project-specific, non-sensitive IDs and environment selectors.
```json
{
  "env": "PARRIS",
  "projectId": "5U5vIHIc1Ug5eVLK",
  "projectName": "Workflows Accelerator <n8n@workflows.ac>",
  "folderId": "Nz4UtQWrmrHMcZIE",
  "folderName": "Case Management Platform",
  "references": {
    "projectId": "5U5vIHIc1Ug5eVLK",
    "projectName": "Workflows Accelerator <n8n@workflows.ac>",
    "folderId": "3JiyzwujIPklu0w8",
    "folderName": "AI Examples"
  }
}
```

### 1.2 Global Configuration
**Path:** `~/.n8ncli-global.json` (Local to machine)
Allows storing multiple environments at the instance level (e.g. for different client instances). When the local configuration specifies `"env": "PARRIS"`, parameters are resolved from the corresponding global environment.
```json
{
  "environments": {
    "PARRIS": {
      "instanceUrl": "https://n8n.parris.app",
      "mcpCommand": "npx -y n8n-mcp",
      "dbUrl": "postgres://user:pass@host:port/db?sslmode=verify-full",
      "accessToken": "mcp-access-token",
      "apiKey": "n8n-rest-api-key"
    }
  }
}
```

### 1.3 Secrets & Environment Variables
**Path:** `.env` (Gitignored)
Environment variables override settings from both global and local configurations.
- `N8N_ACCESS_TOKEN`: Standard access token for starting the MCP connection.
- `N8N_API_KEY`: REST API Key used for toggling permissions and REST actions.
- `N8N_DB_URL`: PostgreSQL connection URL to the n8n database for direct folder synchronization.
- `N8N_INSTANCE_URL`: URL of the target n8n instance.
- `N8N_MCP_COMMAND`: Launch command override for the MCP server.

---

## 2. Sync State Database

To track synchronization without polluting the TypeScript files, `n8ncli` maintains a local sync database. It tracks workflow hashes, IDs, and previously synchronized folders to facilitate precise changes and deletions.

**Path:** `n8n/config/sync-state.json` (Gitignored)
```json
{
  "lastSync": "2026-06-07T15:45:45.000Z",
  "workflows": {
    "Leads/Lead Router.workflow.ts": {
      "id": "workflow-id-123",
      "name": "Lead Router",
      "localPath": "Leads/Lead Router.workflow.ts",
      "contentHash": "sha256-hash-value-here",
      "remoteUpdatedAt": "2026-06-07T15:30:00.000Z",
      "folderId": "Nz4UtQWrmrHMcZIE"
    }
  },
  "folders": [
    "Nz4UtQWrmrHMcZIE",
    "tjTlRGYqzDsf3raC",
    "Kq31KMvGK8dTzIqt"
  ]
}
```

---

## 3. Directory Structure

Running `init` and `pull` produces the following local directory structure:

```
my-project/
├── .env                              # Credentials (gitignored)
├── .gitignore                        # Appends .env, sync-state.json, and n8n/references/
└── n8n/
    ├── config/
    │   ├── n8n-cli.json              # Active environment configs (committed)
    │   ├── sync-state.json           # Sync state tracking database (gitignored)
    │   └── workflow-folders.json     # Cached workflow-to-folder relationships
    ├── references/                   # Reference Workflows (gitignored, read-only cache)
    │   ├── index.yaml                # Searchable YAML index (name, path, description)
    │   └── [Folder]/
    │       └── [ReferenceName].workflow.ts
    └── workflows/
        └── [Folder]/                 # Target sync folder matching n8n project structure
            └── [WorkflowName].workflow.ts
```

---

## 4. Commands Reference

All commands support a global `--verbose` flag for detailed stderr logging. Additionally, commands automatically run local workflow conversion from `.json` files to `.workflow.ts` when targets or directories are parsed.

### `n8ncli init`
```bash
n8ncli init --url <url> --access-token <token> [--api-key <key>] [--env <name>] [--project-id <id>] [--folder-id <id>] [--ref-project-id <id>] [--ref-folder-id <id>] [--mcp-command <cmd>] [--db-url <url>]
```
- Sets up folders under `n8n/`.
- Populates/appends `.env` and `.gitignore`.
- Establishes `n8n/config/n8n-cli.json`.
- Saves configurations globally to `~/.n8ncli-global.json` under the specified `--env` namespace.

### `n8ncli projects`
```bash
n8ncli projects [--query <q>] [--type personal|team] [--limit <n>]
```
- Outputs list of projects in the format: `<id> <name> (<type>)`.

### `n8ncli folders`
```bash
n8ncli folders --project-id <id> [--query <q>] [--limit <n>]
```
- Outputs list of folders inside a project in the format: `<id> <name>`.

### `n8ncli pull`
```bash
n8ncli pull [--force] [--hard] [--skip-references] [--db-url <url>] [--api-key <key>] [--url <url>] [--env <name>]
```
- Pulls all workflows matching the configured `projectId`/`folderId`.
- Converts JSON definition to TypeScript using `@n8n/workflow-sdk`'s `generateWorkflowCode`.
- Writes `.workflow.ts` locally and saves metadata to `sync-state.json`.
- **Empty Folder Retention Safety**: Retains empty directories on disk if they exist on the remote instance.
- **Hard Sync (`--hard`)**: Deletes untracked and out-of-scope local workflows.
- Automatically pulls references into `n8n/references/` and recreates `index.yaml`.

### `n8ncli push`
```bash
n8ncli push [--force] [--dry-run] [--db-url <url>] [--api-key <key>] [--url <url>] [--env <name>] [--mcp-command <cmd>] [--access-token <token>]
```
- Evaluates differences between local `.workflow.ts` files, sync state, and remote instance.
- **Deletions:** Calls `archive_workflow` for workflows removed locally.
- **Creations:** Parses local TS code to JSON, runs `create_workflow_from_code` on n8n.
- **Updates:** Runs `update_workflow` for modified TS files.
- **Folder Sync**: If a PostgreSQL `dbUrl` is configured:
  - **Create**: Inserts missing subdirectories into the `folder` table.
  - **Rename/Move**: Detects moved/renamed directories from workflow renames and updates the database record.
  - **Prune**: Deletes folders from the database that were previously pulled/synced but are no longer present locally. Only applies to folders within the scope of the configured base project folder.

### `n8ncli status`
```bash
n8ncli status
```
- Compares local files against `sync-state.json`. Outputs untracked, modified, deleted, or unchanged files. Local-only operation.

### `n8ncli diff`
```bash
n8ncli diff <file>
```
- Retrieves remote version, converts to TS, and prints unified diff (`+` and `-` lines) against the local version.

### `n8ncli validate`
```bash
n8ncli validate [files...]
```
- Compiles TS workflows using `@n8n/workflow-sdk`'s `parseWorkflowCodeToBuilder` and executes local schemas validation. Exit code `1` on failure.

### `n8ncli exec`
```bash
n8ncli exec <workflow-id-or-file> [--mode manual|production] [--input <json>]
```
- Triggers remote execution and prints the Execution ID.

### `n8ncli test`
```bash
n8ncli test <workflow-id-or-file> [--pin-data <json-file>]
```
- Simulates workflow run utilizing local test pin data.

### `n8ncli execution`
```bash
n8ncli execution <workflow-id-or-file> <execution-id> [--include-data] [--nodes <names...>]
```
- Retrieves status, duration, error messages, and output payload from a run execution.

### `n8ncli publish` / `unpublish`
```bash
n8ncli publish <workflow-id-or-file>
```
```bash
n8ncli unpublish <workflow-id-or-file>
```
- Activates/deactivates workflows remote execution schedules.

### `n8ncli nodes`
- `n8ncli nodes search <query>`: Finds matching core and community nodes.
- `n8ncli nodes types <nodeIds...>`: Retrieves TS types for parameter auto-completion.
- `n8ncli nodes suggest <categories...>`: Recommends nodes by category.

### `n8ncli sdk`
```bash
n8ncli sdk [section]
```
- Prints n8n Workflow SDK documentation (`patterns`, `expressions`, `functions`, `guidelines`, `design`, `all`).

---

## 5. Sync & Conflict Resolution Policies

### 5.1 Pull Command Conflicts
When running `pull` and a local file differs from the remote version:
- If `sync-state.json` hash matches the local hash $\rightarrow$ The local copy is unmodified; safe to overwrite.
- If `sync-state.json` hash does not match local hash $\rightarrow$ The local copy was modified. `pull` skips writing and prints `[CONFLICT]` to prevent data loss, unless the `--force` flag is specified.

### 5.2 Push Command Conflicts
When running `push` and a local modification needs to go remote:
- If `sync-state.json`'s `remoteUpdatedAt` matches the current remote updatedAt $\rightarrow$ Remote is unmodified; safe to update.
- If `sync-state.json`'s `remoteUpdatedAt` does not match current remote updatedAt $\rightarrow$ Workflow was changed on the server by someone else. `push` aborts and outputs a conflict alert, bypassed only with `--force`.

### 5.3 Local JSON Conversion
Whenever a local workflow file ends with `.json`, execution of commands automatically triggers a conversion process:
- Generates corresponding TypeScript SDK code.
- Deletes the original `.json` file to prevent duplicate tracking or conflict.
- Continues execution using the newly converted `.workflow.ts` file path.
