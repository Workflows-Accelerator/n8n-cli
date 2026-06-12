import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setVerbose, setJsonMode } from './output.js';
import { initCommand } from './commands/init.js';
import { projectsCommand } from './commands/projects.js';
import { foldersCommand } from './commands/folders.js';
import { pullCommand } from './commands/pull.js';
import { pushCommand } from './commands/push.js';
import { validateCommand } from './commands/validate.js';
import { statusCommand } from './commands/status.js';
import { diffCommand } from './commands/diff.js';
import { execCommand } from './commands/exec.js';
import { testCommand } from './commands/test.js';
import { executionCommand } from './commands/execution.js';
import { publishCommand } from './commands/publish.js';
import { unpublishCommand } from './commands/unpublish.js';
import { nodesCommand } from './commands/nodes.js';
import { sdkCommand } from './commands/sdk.js';
import { environmentsCommand } from './commands/environments.js';
import { importSkillCommand } from './commands/import-skill.js';
import { lintCommand } from './commands/lint.js';
import { standardsCommand } from './commands/standards.js';
import { layoutCommand } from './commands/layout.js';
import { liveCommand } from './commands/live.js';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'));

const program = new Command();

program
  .name('n8ncli')
  .description('AI-First n8n Workflow CLI')
  .version(pkg.version)
  .option('--verbose', 'enable verbose logging', false)
  .option('--json', 'output structured JSON for program integration', false)
  .option('--env <name>', 'specify environment name')
  .option('--config <path>', 'explicit path to n8n-cli.json configuration file')
  .hook('preAction', (thisCommand, actionCommand) => {
    // Set verbose mode if --verbose flag was passed to either main program or subcommand
    const verbose = !!(thisCommand.opts().verbose || actionCommand.opts().verbose);
    setVerbose(verbose);
    // Set JSON mode if --json flag was passed
    const json = !!(thisCommand.opts().json || actionCommand.opts().json);
    setJsonMode(json);
  });

// Register all commands
initCommand(program);
projectsCommand(program);
foldersCommand(program);
pullCommand(program);
pushCommand(program);
validateCommand(program);
statusCommand(program);
diffCommand(program);
execCommand(program);
testCommand(program);
executionCommand(program);
publishCommand(program);
unpublishCommand(program);
nodesCommand(program);
sdkCommand(program);
environmentsCommand(program);
importSkillCommand(program);
lintCommand(program);
standardsCommand(program);
layoutCommand(program);
liveCommand(program);


// Parse arguments asynchronously
program.parseAsync(process.argv).catch(err => {
  console.error('error: ', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
