import { Command } from 'commander';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as output from '../output.js';

export const REPO = 'Workflows-Accelerator/n8n-cli';
export const KINDS = ['bug', 'missing-capability', 'docs'] as const;
export type FeedbackKind = (typeof KINDS)[number];

export interface RunnerResult {
  status: number | null;
  error?: Error | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  signal?: NodeJS.Signals | null;
}

export type Runner = (command: string, args: string[]) => RunnerResult;

export interface FeedbackInput {
  message: string;
  kind?: string;
  command?: string;
  note?: string;
  exitCode?: number;
  json?: boolean;
}

export interface FeedbackReceipt {
  cli: 'n8ncli';
  version: string;
  repo: string;
  kind: FeedbackKind;
  message: string;
  command?: string;
  note?: string;
  exit_code?: number;
  created_at: string;
}

export interface FeedbackOutcome {
  receipt: FeedbackReceipt;
  exitCode: number;
  delivered: boolean;
  channel: string;
  upstream?: Record<string, unknown>;
  issueUrl?: string;
  upstreamOutput?: string;
  error?: string;
  spooled: boolean;
  spoolWarning?: string;
}

export const defaultRunner: Runner = (command, args) =>
  spawnSync(command, args, { shell: false, encoding: 'utf-8' });

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/ghp_[A-Za-z0-9]+/g, 'ghp_[REDACTED]'],
  [/github_pat_[A-Za-z0-9_]+/g, 'github_pat_[REDACTED]'],
  [/gho_[A-Za-z0-9]+/g, 'gho_[REDACTED]'],
  [/sk-[A-Za-z0-9_-]+/g, 'sk-[REDACTED]'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA[REDACTED]'],
  [/:\/\/[^/\s@]*:[^/\s@]+@/g, '://[REDACTED]@'],
  [/Bearer\s+\S+/gi, 'Bearer [REDACTED]'],
  [/(--(?:access-token|api-key|token|password))(?:\s+|=)\S+/gi, '$1=[REDACTED]'],
  [/("(?:apiKey|accessToken|token|secret|password)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"'],
  [
    /((?:N8N_API_KEY|X-N8N-API-KEY|[A-Za-z0-9_-]*(?:TOKEN|API_KEY|API-KEY|SECRET|PASSWORD)))\s*[:=]\s*\S+/gi,
    '$1=[REDACTED]',
  ],
];

export function scrubSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

export function validateKind(kind: string): FeedbackKind {
  if (!KINDS.includes(kind as FeedbackKind)) throw new Error(`Invalid --kind "${kind}". Expected one of: ${KINDS.join(', ')}.`);
  return kind as FeedbackKind;
}

export function parseExitCode(raw: string): number {
  const value = raw.trim();
  if (!/^-?\d+$/.test(value)) throw new Error(`Invalid --exit-code "${raw}". Expected an integer.`);
  return Number(value);
}

function asText(value: string | Buffer | null | undefined): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : value.toString('utf-8');
}

function signalExitCode(signal: NodeJS.Signals | null | undefined): number {
  if (!signal) return 1;
  const number = (os.constants.signals as Record<string, number>)[signal];
  return number ? 128 + number : 1;
}

function parseUpstream(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return undefined;
}

function spoolReceipt(receipt: FeedbackReceipt): { spooled: boolean; spoolWarning?: string } {
  const target = process.env.OC_FEEDBACK_SPOOL_FILE?.trim();
  if (!target) return { spooled: false };

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });

    let symlink = false;
    try {
      symlink = fs.lstatSync(target).isSymbolicLink();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (symlink) throw new Error(`Refusing to write spool file "${target}": path is a symbolic link.`);

    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(target, flags, 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(receipt)}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return { spooled: true };
  } catch (err) {
    return { spooled: false, spoolWarning: scrubSecrets(err instanceof Error ? err.message : String(err)) };
  }
}

export function submitFeedback(input: FeedbackInput, version: string, runner: Runner = defaultRunner): FeedbackOutcome {
  const kind = validateKind(input.kind ?? 'bug');
  const message = scrubSecrets(input.message);
  const command = input.command ? scrubSecrets(input.command) : undefined;
  const note = input.note ? scrubSecrets(input.note) : undefined;
  const extras = [
    ...(command ? ['--command', command] : []),
    ...(note ? ['--note', note] : []),
    ...(input.exitCode !== undefined ? ['--exit-code', String(input.exitCode)] : []),
    ...(input.json ? ['--json'] : []),
  ];
  const receipt: FeedbackReceipt = {
    cli: 'n8ncli',
    version,
    repo: REPO,
    kind,
    message,
    created_at: new Date().toISOString(),
    ...(command ? { command } : {}),
    ...(note ? { note } : {}),
    ...(input.exitCode !== undefined ? { exit_code: input.exitCode } : {}),
  };
  const attempts: Array<[string, string[]]> = [
    ['oc-feedback', ['--repo', REPO, '--cli', 'n8ncli', '--version', version, '--kind', kind, '--message', message, ...extras]],
    ['oc-cli-feedback', ['--cli', 'n8ncli', '--message', message, ...extras]],
  ];

  for (const [binary, args] of attempts) {
    const result = runner(binary, args);
    if (result.error) continue;

    const stdout = scrubSecrets(asText(result.stdout));
    const stderr = scrubSecrets(asText(result.stderr));
    const upstream = parseUpstream(stdout);
    const issueUrl = typeof upstream?.issueUrl === 'string' ? upstream.issueUrl : undefined;

    if (result.status === null) {
      const reason = result.signal ? `signal ${result.signal}` : 'no exit status';
      return {
        receipt,
        exitCode: signalExitCode(result.signal),
        delivered: false,
        channel: binary,
        error: `Helper ${binary} terminated by ${reason}`,
        spooled: false,
        ...(upstream ? { upstream } : {}),
        ...(stdout.trim() ? { upstreamOutput: stdout.trim() } : {}),
      };
    }

    if (result.status === 0) {
      return {
        receipt,
        exitCode: 0,
        delivered: true,
        channel: binary,
        spooled: false,
        ...(upstream ? { upstream } : {}),
        ...(issueUrl ? { issueUrl } : {}),
        ...(!upstream && stdout.trim() ? { upstreamOutput: stdout.trim() } : {}),
      };
    }

    const detail = stderr.trim() || stdout.trim() || `Helper ${binary} exited with status ${result.status}`;
    return {
      receipt,
      exitCode: result.status,
      delivered: false,
      channel: binary,
      error: detail,
      spooled: false,
      ...(upstream ? { upstream } : {}),
      ...(stdout.trim() ? { upstreamOutput: stdout.trim() } : {}),
    };
  }

  return { receipt, exitCode: 0, delivered: false, channel: 'local-receipt', ...spoolReceipt(receipt) };
}

export function feedbackCommand(program: Command) {
  program
    .command('feedback <message>')
    .description('Send feedback about n8ncli to the maintainers')
    .option('--kind <kind>', `feedback kind: ${KINDS.join(', ')}`, 'bug')
    .option('--command <cmd>', 'command that triggered the feedback')
    .option('--note <text>', 'extra context to include with the report')
    .option('--exit-code <n>', 'exit code of the failing command')
    .option('--json', 'output structured JSON', false)
    .action((message: string, options: { kind: string; command?: string; note?: string; exitCode?: string; json?: boolean }) => {
      const json = options.json || output.getJsonMode();
      let exitCode: number | undefined;
      try {
        exitCode = options.exitCode === undefined ? undefined : parseExitCode(options.exitCode);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        if (json) console.log(JSON.stringify({ error: text }, null, 2));
        else process.stderr.write(`error: ${text}\n`);
        process.exit(2);
      }

      try {
        const outcome = submitFeedback(
          { message, kind: options.kind, command: options.command, note: options.note, exitCode, json },
          program.version() ?? '0.0.0',
        );
        const payload = {
          ...outcome.receipt,
          ...(outcome.upstream ? { upstream: outcome.upstream } : {}),
          ...(outcome.issueUrl ? { issueUrl: outcome.issueUrl } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
          delivered: outcome.delivered,
          channel: outcome.channel,
          spooled: outcome.spooled,
          ...(outcome.spoolWarning ? { spoolWarning: outcome.spoolWarning } : {}),
        };

        if (json) {
          console.log(JSON.stringify(payload, null, 2));
        } else if (outcome.delivered) {
          if (outcome.issueUrl) output.log(`Feedback delivered via ${outcome.channel}: ${outcome.issueUrl}`);
          else if (outcome.upstreamOutput) output.log(outcome.upstreamOutput);
          else output.log(`Feedback delivered via ${outcome.channel}.`);
        } else if (outcome.channel === 'local-receipt') {
          if (outcome.spoolWarning) process.stderr.write(`warn: feedback was not recorded: ${outcome.spoolWarning}\n`);
          output.log(`Feedback not delivered (no feedback helper installed).\n${JSON.stringify(outcome.receipt, null, 2)}`);
        } else {
          process.stderr.write(`${outcome.error ?? 'Feedback delivery failed.'}\n`);
        }

        if (outcome.exitCode !== 0) process.exit(outcome.exitCode);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
