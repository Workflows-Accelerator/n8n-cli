import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { findRepoRoot, loadConfig, convertLocalJsonWorkflows, resolveAndConvertTarget, getConnectionInfo } from '../config.js';
import { parseWorkflowCodeToBuilder, generateWorkflowCode } from '@n8n/workflow-sdk';
import { withMcp, parseLatestVersions, fetchLatestNodeVersions } from '../mcp-client.js';
import * as output from '../output.js';
import { loadStandards, validateWorkflowAgainstStandards, isIgnored, diagnoseChainParentheses } from '../lint-engine.js';
import { loadSyncState, saveSyncState, calculateHash } from '../sync-state.js';
import { loadNodesDatabase } from '../layout-engine.js';

export function validateCommand(program: Command) {
  program
    .command('validate')
    .description('Validate local workflow TypeScript files against n8n schemas')
    .argument('[files...]', 'specific workflow files to validate (defaults to all under n8n/workflows/)')
    .option('--no-version-check', 'skip node version validation against n8n instance')
    .option('--upgrade-nodes', 'auto-upgrade node typeVersions to the latest available from n8n MCP server')
    .option('--fix', 'auto-correct node typeVersions to latest versions (alias for --upgrade-nodes)')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .option('--api-key <key>', 'override n8n REST API key')
    .option('--url <url>', 'override n8n instance URL')
    .option('--env <name>', 'override environment name')
    .option('--lint', 'also run standards lint checks alongside validation')
    .option('--only-modified', 'only validate files that have local modifications', false)
    .option('--fail-on-warnings', 'fail with exit code 2 if any warnings are detected')
    .action(async (files, options) => {
      try {
        await loadNodesDatabase();
        const repoRoot = findRepoRoot();
        if (!repoRoot) {
          throw new Error('Project must be initialized. Run `n8ncli init` first.');
        }

        const config = loadConfig(repoRoot);
        const localDir = config.localDir || 'n8n';
        const syncState = loadSyncState(repoRoot, localDir);

        const workflowsDir = path.join(repoRoot, localDir, 'workflows');
        convertLocalJsonWorkflows(workflowsDir);
        
        let filesToValidate: string[] = [];

        if (files && files.length > 0) {
          filesToValidate = files.map((f: string) => path.resolve(resolveAndConvertTarget(f, workflowsDir)));
        } else {
          if (!fs.existsSync(workflowsDir)) {
            throw new Error(`Workflows directory not found at ${workflowsDir}`);
          }
          const globbed = glob.sync('**/*.workflow.ts', { cwd: workflowsDir });
          filesToValidate = globbed.map(f => path.join(workflowsDir, f));
        }

        if (filesToValidate.length === 0) {
          output.log('No workflow files found to validate.');
          return;
        }

        // 1. First pass: Parse all workflows to builders and extract used node types
        const parsedWorkflows: Array<{
          file: string;
          relativePath: string;
          builder?: any;
          parseError?: string;
          isSkipped?: boolean;
          skipReason?: string;
        }> = [];

        const uniqueNodeTypes = new Set<string>();
        const standards = loadStandards(repoRoot);

        for (const file of filesToValidate) {
          const relativePath = path.relative(repoRoot, file).replace(/\\/g, '/');
          
          if (!fs.existsSync(file)) {
            parsedWorkflows.push({ file, relativePath, parseError: 'File does not exist' });
            continue;
          }

          // Check if --only-modified option is enabled and file is unmodified locally
          if (options.onlyModified) {
            const stateKey = path.relative(workflowsDir, file).replace(/\\/g, '/');
            const entry = syncState.workflows[stateKey];
            try {
              const content = fs.readFileSync(file, 'utf-8');
              const isModified = !entry || entry.contentHash !== calculateHash(content);
              if (!isModified) {
                parsedWorkflows.push({
                  file,
                  relativePath,
                  isSkipped: true,
                  skipReason: 'unmodified locally'
                });
                continue;
              }
            } catch (err) {
              // Let it be handled by standard parser
            }
          }

          // Check for inline ignore comments
          let isIgnoredFile = false;
          try {
            const content = fs.readFileSync(file, 'utf-8');
            const lines = content.split('\n', 10);
            for (const line of lines) {
              if (line.includes('n8ncli-ignore') || line.includes('n8ncli-push-ignore') || line.includes('n8n-cli-ignore')) {
                isIgnoredFile = true;
                break;
              }
            }
          } catch (e) {}

          if (isIgnoredFile) {
            parsedWorkflows.push({
              file,
              relativePath,
              isSkipped: true,
              skipReason: 'inline ignore comment'
            });
            continue;
          }

          // Check if parent directory is ignored
          const folderParts = path.dirname(relativePath).split('/').filter(p => p && p !== '.' && p !== 'workflows' && p !== 'n8n');
          const isParentFolderIgnored = folderParts.some(folderPart => isIgnored(folderPart, standards.ignore?.folders));
          if (isParentFolderIgnored) {
            parsedWorkflows.push({
              file,
              relativePath,
              isSkipped: true,
              skipReason: 'folder ignored'
            });
            continue;
          }

          try {
            const content = fs.readFileSync(file, 'utf-8');
            const builder = parseWorkflowCodeToBuilder(content);
            parsedWorkflows.push({ file, relativePath, builder });

            try {
              const workflowJson = builder.toJSON();
              if (workflowJson.nodes && Array.isArray(workflowJson.nodes)) {
                for (const node of workflowJson.nodes) {
                  if (node.type) {
                    uniqueNodeTypes.add(node.type);
                  }
                }
              }
            } catch (e) {
              // ignore JSON serialization issues during type extraction
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            let diagWarnings: string[] = [];
            try {
              const content = fs.readFileSync(file, 'utf-8');
              diagWarnings = diagnoseChainParentheses(content);
            } catch (diagErr) {}

            let fullErrMsg = errMsg;
            if (diagWarnings.length > 0) {
              fullErrMsg += `\n    Diagnostic Warnings:\n    ` + diagWarnings.map(w => `⚠️  ${w}`).join('\n    ');
            }
            parsedWorkflows.push({ file, relativePath, parseError: fullErrMsg });
          }
        }

        // 2. Query MCP for latest versions of unique node types
        let latestVersions: Record<string, number> = {};
        if (options.versionCheck !== false && uniqueNodeTypes.size > 0) {
          latestVersions = await fetchLatestNodeVersions(uniqueNodeTypes, options);
        }

        // 3. Second pass: Validate each workflow and check node versions
        let overallSuccess = true;
        const jsonResults: any[] = [];

        for (const pw of parsedWorkflows) {
          const relativePath = pw.relativePath;

          if (pw.isSkipped) {
            if (output.getJsonMode()) {
              jsonResults.push({
                file: relativePath,
                exists: true,
                success: true,
                errors: [],
                warnings: [],
                skipped: true,
                reason: pw.skipReason
              });
            } else {
              output.log(`[VALID]   ${relativePath} (skipped: ${pw.skipReason})`);
            }
            continue;
          }

          if (pw.parseError) {
            if (output.getJsonMode()) {
              jsonResults.push({
                file: relativePath,
                exists: pw.parseError !== 'File does not exist',
                success: false,
                errors: [pw.parseError],
                warnings: []
              });
            } else {
              if (pw.parseError === 'File does not exist') {
                output.error(`File does not exist: ${relativePath}`);
              } else {
                output.error(`[ERROR]   ${relativePath}: Failed to parse file.`);
                output.error(`  - ${pw.parseError}`);
              }
            }
            overallSuccess = false;
            continue;
          }

          const builder = pw.builder;
          const validation = builder.validate();

          const errors = validation.errors.map((e: any) => e.message);
          const warnings = validation.warnings.map((w: any) => w.message);

          let hasLintWarnings = false;
          if (options.lint) {
            try {
              const workflowJson = builder.toJSON();
              const lintRes = validateWorkflowAgainstStandards(workflowJson, standards, relativePath);
              errors.push(...lintRes.errors);
              warnings.push(...lintRes.warnings);
              if (lintRes.warnings.length > 0) {
                hasLintWarnings = true;
              }
            } catch (err) {
              errors.push(`Lint checks failed to run: ${err instanceof Error ? err.message : String(err)}`);
            }

            try {
              const content = fs.readFileSync(pw.file, 'utf-8');
              const diagWarnings = diagnoseChainParentheses(content);
              warnings.push(...diagWarnings);
            } catch (e) {}
          }

          // Node version validation & auto-upgrades
          if (options.versionCheck !== false) {
            try {
              const workflowJson = builder.toJSON();
              let upgradedCount = 0;
              const shouldUpgrade = !!(options.upgradeNodes || options.fix);

              if (workflowJson.nodes && Array.isArray(workflowJson.nodes)) {
                for (const node of workflowJson.nodes) {
                  if (node.type && node.typeVersion !== undefined) {
                    const latest = latestVersions[node.type];
                    if (latest !== undefined && node.typeVersion < latest) {
                      if (shouldUpgrade) {
                        node.typeVersion = latest;
                        upgradedCount++;
                      } else {
                        errors.push(`Node "${node.name || node.type}" is using version ${node.typeVersion}, but the latest version is ${latest}.`);
                      }
                    }
                  }
                }

                if (shouldUpgrade && upgradedCount > 0) {
                  const upgradedCode = generateWorkflowCode(workflowJson);
                  fs.writeFileSync(pw.file, upgradedCode, 'utf-8');
                  const stateKey = path.relative(workflowsDir, pw.file).replace(/\\/g, '/');
                  if (syncState.workflows[stateKey]) {
                    syncState.workflows[stateKey].contentHash = calculateHash(upgradedCode);
                  }
                  saveSyncState(repoRoot, syncState, localDir);
                  if (!output.getJsonMode()) {
                    output.log(`[UPGRADED] ${relativePath} (${upgradedCount} node${upgradedCount > 1 ? 's' : ''} upgraded to latest typeVersion)`);
                  }
                }
              }
            } catch (e) {
              // ignore
            }
          }

          const hasErrors = errors.length > 0;
          const hasWarnings = warnings.length > 0;

          if (output.getJsonMode()) {
            jsonResults.push({
              file: relativePath,
              exists: true,
              success: !hasErrors,
              errors,
              warnings
            });
          }

          if (hasErrors || hasWarnings) {
            if (!output.getJsonMode()) {
              if (hasErrors) {
                output.error(`[INVALID] ${relativePath}`);
              } else {
                output.log(`[WARNING] ${relativePath}`);
              }
              for (const err of errors) {
                output.error(`  - [ERROR] ${err}`);
              }
              for (const warn of warnings) {
                output.warn(`  - [WARNING] ${warn}`);
              }
            }
            const failOnWarnings = !!options.failOnWarnings;
            if (hasErrors || (failOnWarnings && warnings.length > 0)) {
              overallSuccess = false;
            }
          } else {
            if (!output.getJsonMode()) {
              output.log(`[VALID]   ${relativePath}`);
            }
          }
        }

        if (output.getJsonMode()) {
          console.log(JSON.stringify({
            success: overallSuccess,
            results: jsonResults
          }, null, 2));
        }

        if (!overallSuccess) {
          process.exit(2);
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
