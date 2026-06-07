import { Command } from 'commander';
import { setVerbose } from './output.js';
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

const program = new Command();

program
  .name('n8ncli')
  .description('AI-First n8n Workflow CLI')
  .version('1.0.0')
  .option('--verbose', 'enable verbose logging', false)
  .hook('preAction', (thisCommand, actionCommand) => {
    // Set verbose mode if --verbose flag was passed to either main program or subcommand
    const verbose = !!(thisCommand.opts().verbose || actionCommand.opts().verbose);
    setVerbose(verbose);
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

// Parse arguments asynchronously
program.parseAsync(process.argv).catch(err => {
  console.error('error: ', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
