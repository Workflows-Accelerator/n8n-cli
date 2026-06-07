import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { findRepoRoot, loadConfig, convertLocalJsonWorkflows, resolveAndConvertTarget } from '../config.js';
import { parseWorkflowCodeToBuilder } from '@n8n/workflow-sdk';
import * as output from '../output.js';

export function validateCommand(program: Command) {
  program
    .command('validate')
    .description('Validate local workflow TypeScript files against n8n schemas')
    .argument('[files...]', 'specific workflow files to validate (defaults to all under n8n/workflows/)')
    .action(async (files) => {
      try {
        const repoRoot = findRepoRoot();
        if (!repoRoot) {
          throw new Error('Project must be initialized. Run `n8ncli init` first.');
        }

        const config = loadConfig(repoRoot);
        const localDir = config.localDir || 'n8n';

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

        let overallSuccess = true;
        const jsonResults: any[] = [];

        for (const file of filesToValidate) {
          const relativePath = path.relative(repoRoot, file).replace(/\\/g, '/');
          
          if (!fs.existsSync(file)) {
            if (output.getJsonMode()) {
              jsonResults.push({ file: relativePath, exists: false, success: false, errors: ['File does not exist'], warnings: [] });
            } else {
              output.error(`File does not exist: ${relativePath}`);
            }
            overallSuccess = false;
            continue;
          }

          try {
            const content = fs.readFileSync(file, 'utf-8');
            const builder = parseWorkflowCodeToBuilder(content);
            const validation = builder.validate();

            const hasErrors = validation.errors.length > 0;
            const hasWarnings = validation.warnings.length > 0;

            if (output.getJsonMode()) {
              jsonResults.push({
                file: relativePath,
                exists: true,
                success: !hasErrors,
                errors: validation.errors.map((e: any) => e.message),
                warnings: validation.warnings.map((w: any) => w.message)
              });
            }

            if (hasErrors) {
              if (!output.getJsonMode()) {
                output.error(`[INVALID] ${relativePath}`);
                for (const err of validation.errors) {
                  output.error(`  - ${err.message}`);
                }
              }
              overallSuccess = false;
            } else if (hasWarnings) {
              if (!output.getJsonMode()) {
                output.log(`[WARNING] ${relativePath}`);
                for (const warn of validation.warnings) {
                  output.warn(`  - ${warn.message}`);
                }
              }
            } else {
              if (!output.getJsonMode()) {
                output.log(`[VALID]   ${relativePath}`);
              }
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (output.getJsonMode()) {
              jsonResults.push({
                file: relativePath,
                exists: true,
                success: false,
                errors: [errMsg],
                warnings: []
              });
            } else {
              output.error(`[ERROR]   ${relativePath}: Failed to parse file.`);
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
