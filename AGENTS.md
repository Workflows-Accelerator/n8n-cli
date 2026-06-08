# 🤖 AI Agent Guidelines for n8n-cli

This document outlines the guidelines and protocols for AI agents developing, contributing to, or utilizing the `n8n-cli` codebase.

---

## 🛠️ Contribution Workflow & Release Lifecycle

When making changes to this codebase, AI agents **MUST** follow these steps to ensure clean integration, up-to-date documentation, and successful package distribution:

### 1. Update npm (Bump Version)
- **Bump Version:** For every push or change that is ready for deployment/release, you must increment the version field in [package.json](file:///c:/Users/lucas/Documents/Code/n8n/n8n-cli/package.json) (e.g., from `1.0.0` to `1.0.1` or the appropriate semver bump).
- **Verify:** Ensure `package-lock.json` is updated by running:
  ```bash
  npm install
  ```

### 2. Update Technical Specifications
- If any command parameters, features, options, or configurations change, you must document those updates in [specs.md](file:///c:/Users/lucas/Documents/Code/n8n/n8n-cli/specs.md).
- Keep the syntax references, configuration paths, and exit codes updated.

### 3. Update Agent Skill File
- When changes are introduced to the CLI commands or linting standards, update the agent skill generator inside [import-skill.ts](file:///c:/Users/lucas/Documents/Code/n8n/n8n-cli/src/commands/import-skill.ts).
- Re-generate and verify the local skill file [SKILL.md](file:///c:/Users/lucas/Documents/Code/n8n/n8n-cli/.agents/skills/n8n/SKILL.md) by running:
  ```bash
  npm run dev -- import-skill
  ```
- Make sure the generated `SKILL.md` starts with the correct metadata frontmatter format:
  ```yaml
  ---
  name: n8ncli
  version: <version>
  description: |
    <description>
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
  ```

---

## 🔬 Local Validation & Building

Before committing or pushing changes:
- Check for compile-time errors by building the project:
  ```bash
  npm run build
  ```
- Ensure the code complies with all TypeScript rules.
