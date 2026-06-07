import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { findRepoRoot, loadConfig } from '../config.js';
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
        let filesToValidate: string[] = [];

        if (files && files.length > 0) {
          filesToValidate = files.map((f: string) => path.resolve(f));
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

        for (const file of filesToValidate) {
          const relativePath = path.relative(repoRoot, file).replace(/\\/g, '/');
          
          if (!fs.existsSync(file)) {
            output.error(`File does not exist: ${relativePath}`);
            overallSuccess = false;
            continue;
          }

          try {
            const content = fs.readFileSync(file, 'utf-8');
            const builder = parseWorkflowCodeToBuilder(content);
            const validation = builder.validate();

            const hasErrors = validation.errors.length > 0;
            const hasWarnings = validation.warnings.length > 0;

            if (hasErrors) {
              output.error(`[INVALID] ${relativePath}`);
              for (const err of validation.errors) {
                output.error(`  - ${err.message}`);
              }
              overallSuccess = false;
            } else if (hasWarnings) {
              output.log(`[WARNING] ${relativePath}`);
              for (const warn of validation.warnings) {
                output.warn(`  - ${warn.message}`);
              }
            } else {
              output.log(`[VALID]   ${relativePath}`);
            }
          } catch (err) {
            output.error(`[ERROR]   ${relativePath}: Failed to parse file.`);
            output.error(`  - ${err instanceof Error ? err.message : String(err)}`);
            overallSuccess = false;
          }
        }

        if (!overallSuccess) {
          process.exit(1);
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
