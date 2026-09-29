# `n8ncli` Technical Specifications

`n8ncli` is an AI-first, token-efficient command-line interface wrapping n8n Model Context Protocol (MCP) server tools. It enables standard TypeScript-based workflow synchronization, validation, execution, and reference material ingestion for local development.

---

## 1. Environment & Configuration

`n8ncli` manages configuration at both the local project level and the machine-wide global level, alongside environment variables for secrets.

### 1.1 Local Configuration
**Path:** `n8n/config/n8n-cli.json` (Committed)
Stores project-specific, non-sensitive IDs and environment selectors.
```json
  "references": [
    {
      "env": "PROD",
      "projectId": "5U5vIHIc1Ug5eVLK",
      "projectName": "My n8n Project <n8n@example.com>",
      "folderId": "3JiyzwujIPklu0w8",
      "folderName": "AI Examples"
    },
    {
      "name": "Local Libraries",
      "path": "../shared-libs/workflows"
    },
    {
      "name": "Community Templates",
      "repository": "https://github.com/n8n-io/n8n.git",
      "branch": "main",
      "path": "templates"
    }
  ]
}
```

### 1.2 Global Configuration
**Path:** `~/.n8ncli-global.json` (Local to machine)
Allows storing multiple environments at the instance level (e.g. for different client instances). When the local configuration specifies `"env": "PROD"`, parameters are resolved from the corresponding global environment.
```json
{
  "environments": {
    "PROD": {
      "instanceUrl": "https://n8n.example.com",
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

All commands support global options: `--verbose` for detailed stderr logging, `--config <path>` to explicitly specify the configuration file path, and `--json` to format output as structured JSON. Additionally, commands automatically run local workflow conversion from `.json` files to `.workflow.ts` when targets or directories are parsed.

### `n8ncli init`
```bash
n8ncli init --url <url> --access-token <token> [--api-key <key>] [--env <name>] [--project-id <id>] [--folder-id <id>] [--ref-project-id <id>] [--ref-folder-id <id>] [--mcp-command <cmd>] [--db-url <url>] [--reset]
```
- Sets up folders under `n8n/`.
- Populates/appends `.env` and `.gitignore`.
- Establishes `n8n/config/n8n-cli.json`.
- Saves configurations globally to `~/.n8ncli-global.json` under the specified `--env` namespace.
- **`--reset`**: Resets the default config files (`n8n-standards.json` and `n8n-layout.json`) to defaults and removes transient local cache files (`sync-state.json`, `workflow-folders.json`, and `unconfigured-credentials.json`). By default, without `--reset`, existing configuration files and custom rules are preserved.

### `n8ncli projects`
```bash
n8ncli projects [--query <q>] [--type personal|team] [--limit <n>]
```
- Outputs list of projects in the format: `<id> <name> (<type>)`.

### `n8ncli folders`
- `n8ncli folders list` (default):
  ```bash
  n8ncli folders list --project-id <id> [--query <q>] [--limit <n>] [--recursive] [--tree] [--parent-folder-id <id>] [--json]
  ```
  Outputs list of folders inside a project. If `--recursive` or `--tree` is specified, lists all nested folders recursively (using a visual tree layout for `--tree`). If `--parent-folder-id` is provided, lists only immediate children of that folder. Supports `--json` for structured output.
- `n8ncli folders create <name>`:
  ```bash
  n8ncli folders create <name> --project-id <id> [--parent-folder-id <id>] [--db-url <url>]
  ```
  Creates a new folder directly in the n8n database.
- `n8ncli folders move <workflow-id-or-path> <folder-id-or-name>`:
  ```bash
  n8ncli folders move <workflow-id-or-path> <folder-id-or-name> [--db-url <url>]
  ```
  Moves a workflow to a specific folder (or `root`) directly in the n8n database.
- `n8ncli folders delete <folder-id-or-name>`:
  ```bash
  n8ncli folders delete <folder-id-or-name> [--no-cascade] [--db-url <url>] [--dry-run]
  ```
  Deletes a folder from the n8n database. If `--no-cascade` is set, workflows and child folders in it are moved to root instead of being deleted. Prints warning details and affected workflows/folders if `--dry-run` is active.
- `n8ncli folders set-parent <folder-id-or-name> <parent-folder-id-or-name>`:
  ```bash
  n8ncli folders set-parent <folder-id-or-name> <parent-folder-id-or-name> [--db-url <url>] [--dry-run]
  ```
  Sets a parent folder for a folder directly in the n8n database. Logs the previous parent name/ID. Prints affected items if `--dry-run` is active.

### `n8ncli pull`
```bash
n8ncli pull [target] [--force] [--hard] [--skip-references] [--db-url <url>] [--api-key <key>] [--url <url>] [--env <name>] [--dry-run]
```
- Pulls workflows matching configured `projectId`/`folderId` (or specific `[target]` workflow file, ID, or folder path).
- **Pure MCP-Only Support**: Operates purely over MCP using only an instance URL and MCP access token. Does not require `N8N_API_KEY` or direct PostgreSQL connection (`N8N_DB_URL`).
- Converts JSON definition to TypeScript using `@n8n/workflow-sdk`'s `generateWorkflowCode`.
- Writes `.workflow.ts` locally and saves metadata to `sync-state.json`. Warns before overwriting modified local files.
- **Empty Folder Retention Safety**: Retains empty directories on disk if they exist on the remote instance.
- **Hard Sync (`--hard`)**: Deletes untracked and out-of-scope local workflows.
- Automatically pulls references from multiple environments/projects, local directories, or Git repositories into `n8n/references/` and recreates `index.yaml`.
- **Dry Run (`--dry-run`)**: Simulates the pull process, listing what files would be created, updated, or deleted without writing to disk or changing sync state.

### `n8ncli push`
```bash
n8ncli push [target] [--all] [--no-cache] [--force] [--dry-run] [--db-url <url>] [--api-key <key>] [--url <url>] [--env <name>] [--mcp-command <cmd>] [--access-token <token>]
```
- Evaluates differences between local `.workflow.ts` files, sync state, and remote instance (optionally scoped to `[target]` workflow file, ID, or folder).
- **`--no-cache`**: Bypasses local sync state content hashes to force clean compilation, linting, layout, and re-pushing of all targeted workflows.
- **Deletions:** Calls `archive_workflow` for workflows removed locally.
- **Creations:** Parses local TS code to JSON, runs `create_workflow_from_code` on n8n.
- **Updates:** Runs `update_workflow` for modified TS files, displaying overwrite warnings when updating existing remote snapshots.
- **Version History Invalidation**: Automatically invalidates and overwrites active version snapshots in PostgreSQL tables (`workflow_history`, `workflow_published_version`, `workflow_entity`) when `dbUrl` is connected so the n8n execution engine immediately uses newly pushed code.
- **Folder Sync**: If a PostgreSQL `dbUrl` is configured:
  - **Create**: Inserts missing subdirectories into the `folder` table.
  - **Rename/Move**: Detects moved/renamed directories from workflow renames and updates the database record.
  - **Prune**: Deletes folders from the database that were previously pulled/synced but are no longer present locally.

### `n8ncli status`
```bash
n8ncli status [--mcp-command <cmd>] [--access-token <token>] [--api-key <key>] [--url <url>] [--env <name>]
```
- Compares local files against `sync-state.json` and optionally remote workflows. Outputs untracked, modified, deleted, unchanged, or remote-only workflows.

### `n8ncli diff`
```bash
n8ncli diff <file> [--semantic]
```
- Retrieves remote version, converts to TS, and prints unified diff (`+` and `-` lines) against the local version.
- **Semantic Diffing (`--semantic`)**: Filters out node coordinate position attributes (`position: [x, y]`) before generating the diff.

### `n8ncli validate` / `n8ncli lint`
  ```bash
  n8ncli validate [files...] [--lint] [--only-modified] [--fail-on-warnings]
  ```
  - Compiles TS workflows using `@n8n/workflow-sdk`'s `parseWorkflowCodeToBuilder` and executes local schema validation and static analysis for broken `$('Node Name')` / `$node['Node Name']` node expression references. Exit code `2` on validation failure or if `--fail-on-warnings` is specified and warnings are detected.
  - **`--lint`**: Enforces naming standards, title casing, node description notes, and static expression references.

### `n8ncli exec`
```bash
n8ncli exec <workflow-id-or-file> [--mode manual|production] [--input <json>]
```
- Triggers remote execution and prints execution result or formatted node error stack traces on failure.

### `n8ncli test`
```bash
n8ncli test <workflow-id-or-file> [--pin-data <json-file>]
```
- Simulates workflow run utilizing local test pin data.

### `n8ncli execution`
```bash
n8ncli execution <workflow-id-or-file> <execution-id> [--include-data] [--nodes <names...>] [--node <names...>] [--truncate <n>]
```
- Retrieves status, duration, error messages, and output payload from a run execution.

### `n8ncli logs`
```bash
n8ncli logs [workflow-id-or-file] [--limit <n>] [--failed-only] [--db-url <url>]
```
- Fetches and formats recent execution logs for a workflow from PostgreSQL database or API, displaying execution status, failing node name, error message, and stack trace for failed runs.

### `n8ncli debug`
```bash
n8ncli debug <execution-id> [--db-url <url>]
```
- Directly inspects an execution ID from PostgreSQL or API, formatting the exact failing node name, line numbers, stack trace, and input/output payload snapshot.

### `n8ncli publish` / `unpublish`
```bash
n8ncli publish <workflow-id-or-file> [--db-url <url>]
```
```bash
n8ncli unpublish <workflow-id-or-file>
```
- Activates/deactivates workflows. When `dbUrl` is connected, `publish` invalidates `workflow_history` active version snapshots in PostgreSQL to ensure production execution immediately picks up changes.

### `n8ncli nodes`
- `n8ncli nodes search <query>`: Finds matching core and community nodes.
- `n8ncli nodes types <nodeIds...>`: Retrieves TS types for parameter auto-completion. Supports colon-separated resource and operation discriminators (e.g. `n8n-nodes-base.gmail:message:send`).
- `n8ncli nodes doc <nodeId>`: Generates interactive documentation, a copy-pasteable TypeScript SDK code example showing default options/types, a summary parameter table, and raw type definitions. Supports colon-separated resource and operation discriminators.
- `n8ncli nodes suggest <categories...>`: Recommends nodes by category.

### `n8ncli sdk`
```bash
n8ncli sdk [section-or-query]
```
- Prints n8n Workflow SDK documentation. Supports specific sections (`patterns`, `expressions`, `functions`, `guidelines`, `design`, `all`) or case-insensitive keyword search filtering.

### `n8ncli datatables`
- `n8ncli datatables list` (default):
  ```bash
  n8ncli datatables list [--db-url <url>]
  ```
  Lists all user tables in the n8n PostgreSQL database.
- `n8ncli datatables query <table-name>`:
  ```bash
  n8ncli datatables query <table-name> [--filter <filter>] [--limit <n>] [--db-url <url>]
  ```
  Queries rows from a specific table, applying an optional SQL filter and row limit.
- `n8ncli datatables update <table-name>`:
  ```bash
  n8ncli datatables update <table-name> --data <json> [--filter <filter>] [--db-url <url>]
  ```
  Updates rows in a specific table with JSON data, applying an optional SQL filter.

### `n8ncli environments` / `env`
- `n8ncli env list` (or `n8ncli env` / `envs`): Lists all configured n8n environments from the global configuration (~/.n8ncli-global.json).
- `n8ncli env test [name]`: Tests REST API, MCP Server, and PostgreSQL database connections for a specific environment (or all configured environments if `name` is omitted). Returns `SUCCESS`, `FAILURE`, or `SKIPPED` (for unconfigured optional services like REST API or DB) with connection status details.
- `n8ncli env edit <name>`: Interactively or via flags creates or modifies settings for a specific environment (saved in `~/.n8ncli-global.json`). Interactive mode prompts for instance URL, access token, optional API key, and optional DB URL, automatically defaulting `mcpCommand` without prompting. Flags: `--url <url>`, `--mcp-command <cmd>`, `--access-token <token>`, `--api-key <key>`, `--db-url <url>`.
- `n8ncli env delete <name>` (or `remove`): Removes an environment configuration from global config settings.

### `n8ncli lint`
  ```bash
  n8ncli lint [--fix] [--only-modified] [--fail-on-warnings]
  ```
  - Validates local workflow style standards against `n8n-standards.json`.
  - Automatically corrects duplicate node name formatting and expression connections when `--fix` is passed.
  - **`--only-modified`**: Only runs lint checks on workflows that have local modifications (new, modified, or renamed compared to `sync-state.json`).
  - **`--fail-on-warnings`**: Fails with exit code `2` if any warnings are detected.

### `n8ncli standards`
- `n8ncli standards validate`: Validates syntax, structure, and constraints of `n8n-standards.json`.
- `n8ncli standards init [--force]`: Generates a standard default `n8n-standards.json` file.
- `n8ncli standards allow <words...>`: Appends one or more words to the allowed words configuration in `n8n-standards.json`.

### `n8ncli layout`
```bash
n8ncli layout [files...] [--nodesep <px>] [--ranksep <px>] [--grid <px>] [--no-align-terminal-nodes] [--subnode-sep <px>] [--subnode-horizontal-sep <px>] [--alignment <mode>] [--dry-run]
```
- Auto-positions nodes in local `.workflow.ts` files using the Dagre layout engine.
- Automatically resolves sizes for standard nodes, triggers, sticky notes, flex nodes, and AI clusters or sub-clusters based on their port signatures.
- Resolves parameters from:
  1. Command-line options
  2. A dedicated `n8n-layout.json` configuration file in the config folder (e.g. `n8n/config/n8n-layout.json`)
  3. Local `n8n-cli.json` configuration (`layout` object)
  4. Fallback defaults (e.g., `nodesep = 80`, `ranksep = 120`, `grid = 20`, `alignment = center`).
- **`--nodesep <px>`**: Specifies node separation distance in pixels (defaults to `80`, or configured in `n8n-layout.json` / `n8n-cli.json`).
- **`--ranksep <px>`**: Specifies rank (column) separation distance in pixels (defaults to `120`, or configured in `n8n-layout.json` / `n8n-cli.json`).
- **`--grid <px>`**: Snapping grid size in pixels (defaults to `20`, or configured in `n8n-layout.json` / `n8n-cli.json`).
- **`--no-align-terminal-nodes`**: Disables the vertical alignment of terminal nodes with their closest predecessors.
- **`--subnode-sep <px>`**: Specifies vertical spacing between a parent node and its subnodes (defaults to `160`, or configured in `n8n-layout.json` / `n8n-cli.json`).
- **`--subnode-horizontal-sep <px>`**: Specifies horizontal spacing between subnodes (defaults to `80`, or configured in `n8n-layout.json` / `n8n-cli.json`).
- **`--alignment <mode>`**: Specifies branch alignment method (`center` or `top`, defaults to `center` or configured in `n8n-layout.json` / `n8n-cli.json`). `top` alignment aligns the first branch of a split node to the vertical level of the split node and cascades subsequent branches downwards.
- **`--dry-run`**: Simulates the auto-positioning without modifying the file.

### Local Layout Config Example (`n8n-layout.json`):
```json
{
  "grid": 20,
  "nodesep": 80,
  "ranksep": 120,
  "alignment": "center",
  "alignTerminalNodes": true,
  "subnodeSep": 160,
  "subnodeHorizontalSep": 80
}
```

### `n8ncli live`
```bash
n8ncli live [--interval <seconds>] [--ttl <minutes>] [--stop] [--status] [--foreground] [--db-url <url>] [--api-key <key>] [--url <url>] [--env <name>] [--mcp-command <cmd>] [--access-token <token>]
```
- Starts a live synchronization daemon. By default, it runs as a detached background process. Use `--foreground` to run in the foreground instead.
- **Daemon Management**:
  - `--status`: Prints the status of the daemon (RUNNING or STOPPED), PID, configuration, last check, and active conflicts.
  - `--stop`: Gracefully terminates the running background daemon process.
- **Time-To-Live (TTL)**: Daemon runs with a default TTL of 60 minutes (1 hour) if not specified via `--ttl <minutes>`. It shuts down automatically when the TTL is reached.
- **Auto-Pull/Auto-Push**:
  - Automatically pulls remote updates if there are no local changes.
  - Automatically pushes local updates if there are no remote changes.
  - Automatically archives remote workflows if local files are deleted.
  - Automatically deletes local files if remote workflows are deleted.
- **Interval**: Defaults to `5` seconds when direct PostgreSQL database connection (`--db-url`) is available (efficient polling), and `20` seconds when falling back to REST API polling. Can be overridden via `--interval`.
- **Status File**: Generates and updates `n8n/config/live-status.json` on each tick. The file is structured for easy consumption by AI agents and other processes, detailing daemon status, pid, backend mode, stopAt ISO timestamp, and any active conflicts.

---

## 5. Sync & Conflict Resolution Policies

### 5.1 Workflow Base Caching
To perform precise 3-way merges and distinguish local changes from remote changes:
- `n8ncli` stores a cached copy of the last-synchronized version of each workflow under `n8n/config/cache/workflows/<id>.workflow.ts`.
- This cache is updated automatically on every successful `pull` or `push` operation.
- Cache entries are pruned when a workflow is archived/deleted.

### 5.2 Conflict Identification & 3-Way Diffing
When a change has occurred both locally and remotely since the last synchronization:
- Direct push/pull operations without `--force` are blocked, returning exit code `3`.
- The CLI loads the cached base version of the workflow, the current local code, and the current remote code.
- It displays a 3-way diff, printing:
  1. Diffs of changes made remotely (Base -> Remote)
  2. Diffs of changes made locally (Base -> Local)
- In `live` mode:
  - If a conflict occurs, `conflict: true` is flagged in `sync-state.json`.
  - Auto-sync is suspended for that workflow.
  - The conflict is logged to `live-status.json`'s `conflicts` array with the timestamp and reason.
  - Sync remains suspended for that workflow until resolved (e.g. by running a manual `pull --force`, `push --force`, or manually modifying the local file to align with remote).

### 5.3 Pull Command Conflicts
When running `pull` and a local file differs from the remote version:
- If `sync-state.json` hash matches the local hash $\rightarrow$ The local copy is unmodified; safe to overwrite.
- If `sync-state.json` hash does not match local hash $\rightarrow$ The local copy was modified. `pull` skips writing and prints `[CONFLICT]` to prevent data loss, unless the `--force` flag is specified.

### 5.4 Push Command Conflicts
When running `push` and a local modification needs to go remote:
- If `sync-state.json`'s `remoteUpdatedAt` matches the current remote updatedAt $\rightarrow$ Remote is unmodified; safe to update.
- If `sync-state.json`'s `remoteUpdatedAt` does not match current remote updatedAt $\rightarrow$ Workflow was changed on the server by someone else. `push` aborts and outputs a conflict alert with 3-way diff (if base cache exists), bypassed only with `--force`.

### 5.5 Local JSON Conversion
Whenever a local workflow file ends with `.json`, execution of commands automatically triggers a conversion process:
- Generates corresponding TypeScript SDK code.
- Deletes the original `.json` file to prevent duplicate tracking or conflict.
- Continues execution using the newly converted `.workflow.ts` file path.

### 5.6 Inline Ignore Comments & Config
Workflows can be ignored from status, push synchronization, schema validation, and standards linting:
- **Inline Comment:** Add `// n8ncli-ignore` or `// n8ncli-push-ignore` or `// n8n-cli-ignore` within the first 10 lines of the workflow file.
- **Standards Config:** Add glob patterns/filenames under `ignore.workflows` in `n8n-standards.json`.
- **Local Config:** Add glob patterns/filenames under `ignorePush` in `n8n/config/n8n-cli.json`.

### 5.7 Differentiated Exit Codes
  The CLI utilizes exit codes to allow programmatic integration with AI agents:
  - **`0`**: Successful command completion (warnings do not fail by default).
  - **`1`**: General runtime execution or connection error.
  - **`2`**: Validation failures (validation errors detected during `validate` or `lint`, or warnings when `--fail-on-warnings` is specified).
  - **`3`**: Synchronization conflicts (local/remote modifications diverged during `pull` or `push` without `--force`).
