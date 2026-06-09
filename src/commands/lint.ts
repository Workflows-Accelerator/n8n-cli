import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { findRepoRoot, loadConfig, convertLocalJsonWorkflows } from '../config.js';
import { parseWorkflowCodeToBuilder, generateWorkflowCode } from '@n8n/workflow-sdk';
import { loadStandards, validateWorkflowAgainstStandards, fixWorkflowAgainstStandards, toSmartTitleCase } from '../lint-engine.js';
import { loadSyncState, saveSyncState, calculateHash } from '../sync-state.js';
import * as output from '../output.js';

function cleanEmptyParentDirs(startDir: string, stopDir: string) {
  let dir = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  while (dir !== stop && dir.startsWith(stop)) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    } else {
      break;
    }
  }
}

export function lintCommand(program: Command) {
  program
    .command('lint')
    .description('Enforce n8n workflow conventions and naming standards')
    .option('--fix', 'auto-fix naming conventions and suffixes')
    .action(async (options) => {
      try {
        const repoRoot = findRepoRoot();
        if (!repoRoot) {
          throw new Error('Project must be initialized. Run `n8ncli init` first.');
        }

        const config = loadConfig(repoRoot);
        const localDir = config.localDir || 'n8n';
        const workflowsDir = path.join(repoRoot, localDir, 'workflows');

        // Automatically convert any local JSON workflows
        convertLocalJsonWorkflows(workflowsDir);

        const standards = loadStandards(repoRoot);
        const files = glob.sync('**/*.workflow.ts', { cwd: workflowsDir });
        
        let overallSuccess = true;
        const jsonResults: any[] = [];

        for (const file of files) {
          const relativePath = path.join(localDir, 'workflows', file).replace(/\\/g, '/');
          const fullPath = path.join(workflowsDir, file);

          if (!fs.existsSync(fullPath)) continue;

          try {
            const code = fs.readFileSync(fullPath, 'utf-8');

            // Check for inline ignore comments
            let isIgnoredFile = false;
            const lines = code.split('\n', 10);
            for (const line of lines) {
              if (line.includes('n8ncli-ignore') || line.includes('n8ncli-push-ignore') || line.includes('n8n-cli-ignore')) {
                isIgnoredFile = true;
                break;
              }
            }

            if (isIgnoredFile) {
              if (!output.getJsonMode()) {
                output.log(`[LINT-PASS] ${relativePath} (skipped: inline ignore comment)`);
              }
              continue;
            }

            const builder = parseWorkflowCodeToBuilder(code);
            const workflowJson = builder.toJSON();

            // Run standard validations
            let { errors, warnings } = validateWorkflowAgainstStandards(workflowJson, standards, relativePath);

            // Auto-fixing if requested
            const { modifiedJson, fixedCount } = fixWorkflowAgainstStandards(workflowJson, standards);
            
            const normalizedFile = file.replace(/\\/g, '/');
            const segments = normalizedFile.split('/');
            const correctedSegments = segments.map((seg, i) => {
              if (i === segments.length - 1) {
                const sanitized = (modifiedJson.name || '').replace(/[\\/:*?"<>|]/g, '_');
                return `${sanitized}.workflow.ts`;
              } else {
                return toSmartTitleCase(seg, standards);
              }
            });
            const correctedFile = correctedSegments.join('/');
            const correctedRelativePath = path.join(localDir, 'workflows', correctedFile).replace(/\\/g, '/');
            const correctedFullPath = path.join(workflowsDir, correctedFile);

            if (options.fix && (fixedCount > 0 || correctedFullPath !== fullPath)) {
              const fixedCode = generateWorkflowCode(modifiedJson);
              
              // Write safely handling case-sensitivity
              if (correctedFullPath.toLowerCase() === fullPath.toLowerCase()) {
                if (correctedFullPath !== fullPath) {
                  const tempPath = fullPath + '.tmp';
                  fs.writeFileSync(tempPath, fixedCode, 'utf-8');
                  fs.unlinkSync(fullPath);
                  fs.renameSync(tempPath, correctedFullPath);
                } else {
                  fs.writeFileSync(fullPath, fixedCode, 'utf-8');
                }
              } else {
                fs.mkdirSync(path.dirname(correctedFullPath), { recursive: true });
                fs.writeFileSync(correctedFullPath, fixedCode, 'utf-8');
                if (fs.existsSync(fullPath)) {
                  fs.unlinkSync(fullPath);
                }
              }

              if (correctedFullPath !== fullPath) {
                cleanEmptyParentDirs(path.dirname(fullPath), workflowsDir);
              }

              // Update sync state
              const syncState = loadSyncState(repoRoot, localDir);
              const oldKey = file.replace(/\\/g, '/');
              const newKey = correctedFile.replace(/\\/g, '/');

              if (syncState.workflows[oldKey]) {
                const entry = syncState.workflows[oldKey];
                delete syncState.workflows[oldKey];
                entry.localPath = newKey;
                entry.name = modifiedJson.name;
                entry.contentHash = calculateHash(fixedCode);
                syncState.workflows[newKey] = entry;
              } else {
                syncState.workflows[newKey] = {
                  id: workflowJson.id || 'untracked_' + Date.now(),
                  name: modifiedJson.name,
                  localPath: newKey,
                  contentHash: calculateHash(fixedCode),
                  remoteUpdatedAt: new Date().toISOString()
                };
              }
              saveSyncState(repoRoot, syncState, localDir);

              output.log(`[FIXED]   ${relativePath} -> ${correctedRelativePath} (fixed nodes/connections/expressions/paths)`);
              
              const reVal = validateWorkflowAgainstStandards(modifiedJson, standards, correctedRelativePath);
              errors = reVal.errors;
              warnings = reVal.warnings;
            }

            const hasErrors = errors.length > 0;
            const hasWarnings = warnings.length > 0;

            if (output.getJsonMode()) {
              jsonResults.push({
                file: relativePath,
                success: !hasErrors && !hasWarnings,
                errors,
                warnings
              });
            }

            if (hasErrors || hasWarnings) {
              if (!output.getJsonMode()) {
                if (hasErrors) {
                  output.error(`[LINT-FAIL] ${relativePath}`);
                } else {
                  output.log(`[LINT-WARN] ${relativePath}`);
                }
                for (const err of errors) {
                  output.error(`  - [ERROR] ${err}`);
                }
                for (const warn of warnings) {
                  output.warn(`  - [WARNING] ${warn}`);
                }
              }
              overallSuccess = false;
            } else {
              if (!output.getJsonMode()) {
                output.log(`[LINT-PASS] ${relativePath}`);
              }
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (output.getJsonMode()) {
              jsonResults.push({
                file: relativePath,
                success: false,
                errors: [errMsg],
                warnings: []
              });
            } else {
              output.error(`[LINT-ERROR] ${relativePath}: Failed to parse/read file.`);
              output.error(`  - ${errMsg}`);
            }
            overallSuccess = false;
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
