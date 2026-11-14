import { Command } from 'commander';
import { spawnSync } from 'child_process';
import fs from 'fs';
import * as output from '../output.js';

export const REPO = 'Workflows-Accelerator/n8n-cli';
export const KINDS = ['bug', 'missing-capability', 'docs'] as const;
export type FeedbackKind = (typeof KINDS)[number];
export type Runner = (command: string, args: string[]) => { status: number | null; error?: Error | null };
export interface FeedbackInput { message: string; kind?: string; command?: string; exitCode?: number; json?: boolean; }
export interface FeedbackReceipt { cli: 'n8ncli'; version: string; repo: string; kind: FeedbackKind; message: string; command?: string; exit_code?: number; created_at: string; }
export interface FeedbackOutcome { receipt: FeedbackReceipt; exitCode: number; delivered: boolean; channel: string; }
export const defaultRunner: Runner = (command, args) => spawnSync(command, args, { shell: false, encoding: 'utf-8' });

const SECRETS: Array<[RegExp, string]> = [
  [/ghp_[A-Za-z0-9]+/g, 'ghp_[REDACTED]'],
  [/sk-[A-Za-z0-9_-]+/g, 'sk-[REDACTED]'],
  [/Bearer\s+\S+/gi, 'Bearer [REDACTED]'],
  [/:\/\/[^/\s:@]+:[^/\s@]+@/g, '://[REDACTED]@'],
];

export function scrubSecrets(text: string): string {
  return SECRETS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

export function validateKind(kind: string): FeedbackKind {
  if (!KINDS.includes(kind as FeedbackKind)) throw new Error(`Invalid --kind "${kind}". Expected one of: ${KINDS.join(', ')}.`);
  return kind as FeedbackKind;
}

export function submitFeedback(input: FeedbackInput, version: string, runner: Runner = defaultRunner): FeedbackOutcome {
  const kind = validateKind(input.kind ?? 'bug');
  const message = scrubSecrets(input.message);
  const command = input.command ? scrubSecrets(input.command) : undefined;
  const extras = [
    ...(command ? ['--command', command] : []),
    ...(input.exitCode !== undefined ? ['--exit-code', String(input.exitCode)] : []),
    ...(input.json ? ['--json'] : []),
  ];
  const receipt: FeedbackReceipt = {
    cli: 'n8ncli', version, repo: REPO, kind, message, created_at: new Date().toISOString(),
    ...(command ? { command } : {}), ...(input.exitCode !== undefined ? { exit_code: input.exitCode } : {}),
  };
  const attempts: Array<[string, string[]]> = [
    ['oc-feedback', ['--repo', REPO, '--cli', 'n8ncli', '--version', version, '--kind', kind, '--message', message, ...extras]],
    ['oc-cli-feedback', ['--cli', 'n8ncli', '--message', message, ...extras]],
  ];
  for (const [binary, args] of attempts) {
    const result = runner(binary, args);
    const missing = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
    if (!missing) return { receipt, exitCode: result.status ?? 0, delivered: true, channel: binary };
  }
  const spool = process.env.OC_FEEDBACK_SPOOL_FILE;
  if (spool) { try { fs.appendFileSync(spool, `${JSON.stringify(receipt)}\n`); } catch {} }
  return { receipt, exitCode: 0, delivered: false, channel: 'local-receipt' };
}

export function feedbackCommand(program: Command) {
  program
    .command('feedback <message>')
    .description('Send feedback about n8ncli to the maintainers')
    .option('--kind <kind>', `feedback kind: ${KINDS.join(', ')}`, 'bug')
    .option('--command <cmd>', 'command that triggered the feedback')
    .option('--exit-code <n>', 'exit code of the failing command')
    .option('--json', 'output structured JSON', false)
    .action((message: string, options: { kind: string; command?: string; exitCode?: string; json?: boolean }) => {
      try {
        const json = options.json || output.getJsonMode();
        const exitCode = options.exitCode === undefined ? undefined : Number(options.exitCode);
        const outcome = submitFeedback({ message, kind: options.kind, command: options.command, exitCode, json }, program.version() ?? '0.0.0');
        if (json) console.log(JSON.stringify(outcome.receipt, null, 2));
        else if (outcome.delivered) output.log(`Feedback delivered via ${outcome.channel}.`);
        else output.log(`Feedback recorded locally (oc-feedback not installed).\n${JSON.stringify(outcome.receipt, null, 2)}`);
        if (outcome.exitCode !== 0) process.exit(outcome.exitCode);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
