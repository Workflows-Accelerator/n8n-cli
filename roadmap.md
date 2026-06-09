# n8ncli Roadmap & Backlog

This file tracks improvements, features, and fixes for `n8n-cli`.
*Note: Do not execute the items on this list except if prompted to.*

---

## 🟢 Easy (Low Hanging Fruit)

- [x] **1. Node Naming Regex / Webhook Conventions**
  - *Problem:* Default regex `^[A-Z][a-zA-Z0-9\s()\-:]*$` doesn't allow `/`. Required webhook naming convention is `POST /endpoint`, causing out-of-box validation to fail.
  - *Fix:* Update the default naming regex in the standards/linter to include `/`.
- [x] **2. Default `allowedWords` for Spelling Check**
  - *Problem:* Linter flags common technical terms (`PDF`, `SMS`, `API`, `Gemini`, `Supabase`, `Twilio`, `Gotenberg`, etc.) as spelling errors because `allowedWords` is empty by default.
  - *Fix:* Seed a sensible default list of common technical terms in the standard config.
- [x] **3. Spelling Check Add-to-Allowed Suggestion**
  - *Problem:* Spelling failures are shown, but there is no helper command or warning suggesting how to add them to the allowed list.
  - *Fix:* Print a helpful instruction/command suggestion in the linter output.
- [x] **4. `.gitignore` Guidance on `init`**
  - *Problem:* `init` creates local files like `sync-state.json`, `unconfigured-credentials.json`, `workflow-folders.json` but doesn't guide the user on whether they should commit them.
  - *Fix:* Create a `.gitignore` automatically on `init` or print a clear message with recommended rules.
- [x] **5. Pull Immediately on `init`**
  - *Problem:* After `n8ncli init`, the environment has config but no local files, requiring an manual `pull` which is undocumented in the init success message.
  - *Fix:* Prompt to pull or suggest calling `n8ncli pull` immediately at the end of `init`.
- [x] **6. Document `notes` / `notesInFlow` Placement**
  - *Problem:* Placement is read from `config.notes` / `config.notesInFlow` (not top-level node arguments), but it's undocumented and hard to guess.
  - *Fix:* Document this clearly in `SKILL.md` / SDK docs, and print useful error messages in the schema validator.
- [x] **7. Document `pull` File Renaming Behavior**
  - *Problem:* `pull` silently renames local files to match the workflow's display name, which confuses users naming their local files kebab-case.
  - *Fix:* Document this explicitly in `SKILL.md`: *"pull uses the workflow display name as the filename — don't rely on your own navigation."*

---

## 🟡 Medium (Enhancements & CLI Refinement)

- [x] **8. Distinguish Errors vs. Warnings in Linter Output**
  - *Problem:* `validate` output shows everything as `error:`, making it hard to separate hard schema errors (breaks deployment) from style warnings (e.g. spelling/naming).
  - *Fix:* Visually prefix and distinguish `[ERROR]` vs `[WARNING]` in output while keeping exit code behaviors.
- [x] **9. Section/Targeting Options for `sdk` Command**
  - *Problem:* `n8ncli sdk all` outputs a massive list.
  - *Fix:* Add targeting argument (e.g., `n8ncli sdk webhook` or `n8ncli sdk code-node`).
- [x] **10. Better Error Reporting on Push Bad Request**
  - *Problem:* When a push fails (e.g. because of rename), n8n API returns `Bad Request. Details: {"message":"request/body must NOT have additional properties"}` with no details on the offending property.
  - *Fix:* Catch, parse, and print the offending field name, and gracefully skip/warn instead of failing silently.
- [x] **11. Show Remote-Only Workflows in `status`**
  - *Problem:* `status` doesn't show workflows that exist on remote but have no local file.
  - *Fix:* Add a "Remote-Only Workflows" section to the status output.
- [x] **12. Surface Credential Warnings at Top of Push**
  - *Problem:* Warnings about unconfigured credentials are buried at the bottom of push logs.
  - *Fix:* Highlight credential warnings prominently at the top/summary of the push output.
- [x] **13. Auto-Scaffold TODOs for Description/Notes Gaps in `--fix`**
  - *Problem:* `lint --fix` fixes case issues but doesn't scaffold missing workflow descriptions or code notes.
  - *Fix:* Have it insert `// TODO: add description/notes` stub at the correct config location.
- [x] **14. Push Ignore Annotation / Config**
  - *Problem:* No way to mark specific workflows (e.g., placeholder workflows without triggers) to be ignored during push warnings.
  - *Fix:* Add support for an inline comment or configuration-based ignore directive.

---

## 🔴 Hard / Complex (Structural & Algorithmic)

- [ ] **15. Workflow Positioning / Layout Engine**
  - *Problem:* Positioning nodes properly in code-defined workflows is hard.
  - *Fix:* Integrate a layout engine (like Dagre) to auto-position nodes and determine bounding boxes.
- [ ] **16. Support Multi-Project & Multi-Environment References**
  - *Problem:* References/contexts are currently single-environment/folder.
  - *Fix:* Allow reference resolution from multiple directories, repositories, or environments.
- [ ] **17. Remote-Pulled Standards Violations**
  - *Problem:* Remote files pulled down can immediately violate standards, putting the agent in a catch-22.
  - *Fix:* Skip linter validation on files not modified locally, or warn on pull instead of blocking validation.
- [ ] **18. Debug and Resolve Node Connection Issues**
  - *Problem:* Workflows with one-to-many connections, Switch nodes, or Code nodes often suffer from serialization/connection bugs.
  - *Fix:* Gather examples, debug the serializer, and document correct structures in skills.