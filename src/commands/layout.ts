import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { findRepoRoot, loadConfig, convertLocalJsonWorkflows } from '../config.js';
import { parseWorkflowCodeToBuilder, generateWorkflowCode } from '@n8n/workflow-sdk';
import { layoutWorkflow } from '../layout-engine.js';
import * as output from '../output.js';

export function layoutCommand(program: Command) {
  program
    .command('layout')
    .description('Auto-position nodes in n8n workflows using Dagre')
    .argument('[files...]', 'specific workflow files to layout (defaults to all under n8n/workflows/)')
    .option('--nodesep <px>', 'node separation distance in pixels')
    .option('--ranksep <px>', 'rank separation distance in pixels')
    .option('--grid <px>', 'grid snapping size in pixels')
    .option('--no-align-terminal-nodes', 'disable vertical alignment of terminal nodes')
    .option('--subnode-sep <px>', 'vertical spacing between parent node and its subnodes')
    .option('--subnode-horizontal-sep <px>', 'horizontal spacing between subnodes')
    .option('--dry-run', 'simulate layout without modifying files')
    .action(async (files, options) => {
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

        let filesToLayout: string[] = [];

        if (files && files.length > 0) {
          filesToLayout = files.map((f: string) => {
            const resolved = path.resolve(f);
            if (fs.existsSync(resolved)) return resolved;
            
            // If relative to workflows dir
            const wfPath = path.join(workflowsDir, f);
            if (fs.existsSync(wfPath)) return wfPath;
            const wfTsPath = wfPath.endsWith('.workflow.ts') ? wfPath : `${wfPath}.workflow.ts`;
            if (fs.existsSync(wfTsPath)) return wfTsPath;
            
            return resolved;
          });
        } else {
          if (!fs.existsSync(workflowsDir)) {
            throw new Error(`Workflows directory not found at ${workflowsDir}`);
          }
          const globbed = glob.sync('**/*.workflow.ts', { cwd: workflowsDir });
          filesToLayout = globbed.map(f => path.join(workflowsDir, f));
        }

        if (filesToLayout.length === 0) {
          output.log('No workflow files found to layout.');
          return;
        }

        const layoutConfig = (config as any).layout || {};
        const grid = options.grid !== undefined ? parseInt(options.grid, 10) : (layoutConfig.grid !== undefined ? layoutConfig.grid : 20);
        const nodesep = options.nodesep !== undefined ? parseInt(options.nodesep, 10) : (layoutConfig.nodesep !== undefined ? layoutConfig.nodesep : (2 * grid));
        const ranksep = options.ranksep !== undefined ? parseInt(options.ranksep, 10) : (layoutConfig.ranksep !== undefined ? layoutConfig.ranksep : (6 * grid));

        const alignTerminalNodes = options.alignTerminalNodes !== undefined
          ? options.alignTerminalNodes
          : (layoutConfig.alignTerminalNodes !== undefined ? layoutConfig.alignTerminalNodes : true);

        const subnodeSep = options.subnodeSep !== undefined
          ? parseInt(options.subnodeSep, 10)
          : (layoutConfig.subnodeSep !== undefined ? layoutConfig.subnodeSep : undefined);

        const subnodeHorizontalSep = options.subnodeHorizontalSep !== undefined
          ? parseInt(options.subnodeHorizontalSep, 10)
          : (layoutConfig.subnodeHorizontalSep !== undefined ? layoutConfig.subnodeHorizontalSep : undefined);

        for (const file of filesToLayout) {
          const relativePath = path.relative(repoRoot, file).replace(/\\/g, '/');
          
          if (!fs.existsSync(file)) {
            output.error(`File does not exist: ${relativePath}`);
            continue;
          }

          try {
            const code = fs.readFileSync(file, 'utf-8');
            const builder = parseWorkflowCodeToBuilder(code);
            const workflowJson = builder.toJSON();

            // Run layout engine
            const updatedJson = await layoutWorkflow(workflowJson, {
              nodesep,
              ranksep,
              grid,
              alignTerminalNodes,
              subnodeSep,
              subnodeHorizontalSep
            });

            if (options.dryRun) {
              output.log(`[DRY-RUN] Layout successful for: ${relativePath}`);
            } else {
              const updatedCode = generateWorkflowCode(updatedJson);
              fs.writeFileSync(file, updatedCode, 'utf-8');
              output.log(`[LAYOUT] Successfully positioned nodes in: ${relativePath}`);
            }
          } catch (err) {
            output.error(`[ERROR] Failed to layout '${relativePath}': ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
