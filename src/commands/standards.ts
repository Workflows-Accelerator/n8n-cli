import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { findRepoRoot } from '../config.js';
import { validateStandardsJson, DEFAULT_STANDARDS, getStandardsPath, addAllowedWords } from '../lint-engine.js';
import * as output from '../output.js';

export function standardsCommand(program: Command) {
  const cmd = program
    .command('standards')
    .description('Manage and validate n8n-standards.json standards file');

  cmd
    .command('validate')
    .description('Validate the syntax and structure of n8n-standards.json')
    .action(async () => {
      try {
        const repoRoot = findRepoRoot();
        if (!repoRoot) {
          throw new Error('Project must be initialized. Run `n8ncli init` first.');
        }

        const standardsPath = getStandardsPath(repoRoot);
        if (!fs.existsSync(standardsPath)) {
          throw new Error(`Standards file not found at ${standardsPath}. Run 'n8ncli standards init' to create one.`);
        }

        const content = fs.readFileSync(standardsPath, 'utf-8');
        const errors = validateStandardsJson(content);

        if (errors.length === 0) {
          output.log(`[VALID] standards file is correct: ${path.relative(repoRoot, standardsPath)}`);
          return;
        }

        output.error(`[INVALID] standards file has errors: ${path.relative(repoRoot, standardsPath)}`);
        for (const err of errors) {
          output.error(`  - ${err}`);
        }
        process.exit(2);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  cmd
    .command('allow <words...>')
    .description('Add one or more allowed words to the language standards config')
    .action(async (words) => {
      try {
        const repoRoot = findRepoRoot();
        if (!repoRoot) {
          throw new Error('Project must be initialized. Run `n8ncli init` first.');
        }

        addAllowedWords(repoRoot, words);
        output.log(`Successfully allowed words: ${words.join(', ')}`);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  cmd
    .command('init')
    .description('Initialize default n8n-standards.json file')
    .option('--force', 'overwrite existing standards file if it exists', false)
    .action(async (options) => {
      try {
        const repoRoot = findRepoRoot();
        if (!repoRoot) {
          throw new Error('Project must be initialized. Run `n8ncli init` first.');
        }

        const standardsPath = getStandardsPath(repoRoot);
        if (fs.existsSync(standardsPath) && !options.force) {
          throw new Error(`Standards file already exists at ${standardsPath}. Use --force to overwrite.`);
        }

        const dir = path.dirname(standardsPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // Include default standards with a pre-configured ignoreRules block
        const configWithExemptions = {
          ...DEFAULT_STANDARDS,
          ignoreRules: {
            nodes: {
              titleCase: [
                "n8n-nodes-base.code"
              ],
              namingRegex: [
                "n8n-nodes-base.webhook"
              ],
              duplicateSuffix: [],
              notes: []
            }
          }
        };

        fs.writeFileSync(standardsPath, JSON.stringify(configWithExemptions, null, 2), 'utf-8');
        output.log(`Initialized default standards at: ${path.relative(repoRoot, standardsPath)}`);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
