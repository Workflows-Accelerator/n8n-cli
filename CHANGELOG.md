# Changelog

All notable changes to `n8ncli` (@workflows-accelerator/n8n-cli) are documented in this file.

## [1.2.44] - 2026-10-23
### Changed
- **Enhanced Agent Skill Self-Usage & Directives**: Updated skill description with strict trigger directives ensuring AI agents automatically load the `n8ncli` skill whenever n8n is mentioned, and explicitly prohibiting falling back to raw MCP calls or the official global `n8n` CLI.

## [1.2.43] - 2026-10-23
### Added
- **New Version Alert**: Automated, non-blocking check alerting users when a new version of `n8ncli` is published on npm.
- **Self-Update Command (`n8ncli update` / `n8ncli upgrade`)**: One-command upgrading via `n8ncli update` with `--check`, `--force`, and `--tag` options.
- **Changelog Command (`n8ncli changelog` / `n8ncli whatsnew`)**: Inspect release notes and changes between versions directly from the CLI with `--all`, `--limit`, and `--from` options.

## [1.2.42] - 2026-10-22
### Added
- **Instance URL Auto-Trimming**: Automatically extracts the canonical instance base URL when users paste full workflow URLs (`/workflow/...`), settings pages (`/settings/...`), execution pages, webhook URLs, query parameters, or hashes.
- **Direct Credential Guidance Links**: Displays direct URLs to locate the MCP Access Token (`<baseUrl>/settings/mcp`) and REST API Key (`<baseUrl>/settings/api`) during `init`, `env edit`, and in authentication error messages.

## [1.2.41] - 2026-10-22
### Fixed
- **Push Failure Safety**: Push write failures across REST API, database, or MCP now halt cache updates, prevent false `[UPDATED]` logs, and exit with code `1`.
- **Pure MCP AST Updates**: Implemented full AST diffing (`generateWorkflowUpdateOperations`) batched in chunks of 100 operations for pure MCP-only environments without REST API or PostgreSQL.
- **Pull Validation**: Pull throws an error and exits with code `1` when a specified `projectId` or `[target]` filter matches no remote workflows.
- **Credential Validation & Trimming**: Automatically trims whitespace and newlines from credentials (e.g. from clipboard) and rejects invalid control characters that trigger HTTP header errors.

## [1.2.40] - 2026-10-22
### Fixed
- Supported `response.data` format in folder search responses.
- Added exponential backoff and rate-limit retry handling for REST API and MCP endpoints.
- Merged layout engine, standards validator, and workflow templates.

## [1.2.39] - 2026-10-22
### Added
- Pure MCP-only UX streamlining for pulling and syncing without requiring REST API keys or database connections.
