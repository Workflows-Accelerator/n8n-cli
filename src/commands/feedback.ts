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
  helperStatus?: number | null;
  helperStderr?: string;
  error?: string;
  spooled: boolean;
  spoolWarning?: string;
}

export const defaultRunner: Runner = (command, args) =>
  spawnSync(command, args, { shell: false, encoding: 'utf-8' });

/** GitHub classic personal access token. */
const GITHUB_PAT = /ghp_[A-Za-z0-9]+/g;
/** GitHub fine-grained personal access token. */
const GITHUB_FINE_PAT = /github_pat_[A-Za-z0-9_]+/g;
/** GitHub OAuth token. */
const GITHUB_OAUTH = /gho_[A-Za-z0-9]+/g;
/** OpenAI-style key; the lookbehind keeps words such as "task-runner" and "desk-lamp" intact but still catches "mykey_sk-". */
const OPENAI_KEY = /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]+/g;
/** AWS access key ID. */
const AWS_ACCESS_KEY = /AKIA[0-9A-Z]{16}/g;
/** URL credentials; both classes stop at ":" and "@", so the scan never backtracks across the pair. */
const URL_CREDENTIALS = /:\/\/[^/\s@:]*:[^/\s@]+@/g;
/** Bearer authorization value. */
const BEARER_VALUE = /Bearer\s+\S+/gi;
/** Token-bearing command line flag. */
const SECRET_FLAG = /(--(?:access-token|api-key|token|password))(?:\s+|=)\S+/gi;
/** JSON-style secret field; the value may be a string, number or boolean. */
const JSON_SECRET_FIELD = /("(?:apiKey|accessToken|token|secret|password)"\s*:\s*)(?:"[^"]*"|-?\d+(?:\.\d+)?|true|false)/gi;
/**
 * Key/value assignment. Only keys that END in a secret suffix match, and the
 * alternation is a fixed set of literals with no nested quantifier, so the scan
 * stays linear. Matching starts at the suffix, so the key prefix is preserved.
 */
const SECRET_ASSIGNMENT = /(TOKEN|API_KEY|API-KEY|APIKEY|SECRET|PASSWORD|PASSWD)(\s*[:=]\s*)([^\s&;?#]+)/gi;
/** Key suffix whose value is a secret, anchored at the end of a parsed JSON key. */
const SECRET_KEY_SUFFIX = /(?:TOKEN|API_KEY|API-KEY|APIKEY|SECRET|PASSWORD|PASSWD)$/i;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [GITHUB_PAT, 'ghp_[REDACTED]'],
  [GITHUB_FINE_PAT, 'github_pat_[REDACTED]'],
  [GITHUB_OAUTH, 'gho_[REDACTED]'],
  [OPENAI_KEY, 'sk-[REDACTED]'],
  [AWS_ACCESS_KEY, 'AKIA[REDACTED]'],
  [URL_CREDENTIALS, '://[REDACTED]@'],
  [BEARER_VALUE, 'Bearer [REDACTED]'],
  [SECRET_FLAG, '$1=[REDACTED]'],
  [JSON_SECRET_FIELD, '$1"[REDACTED]"'],
  [SECRET_ASSIGNMENT, '$1$2[REDACTED]'],
];

/** True when a field name ends in a secret suffix, for example N8N_API_KEY or MY_SECRET. */
function isSecretKeyName(key: string): boolean {
  return SECRET_KEY_SUFFIX.test(key);
}

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

/** Scrub every string leaf and key of parsed helper JSON; secret-named fields also drop number/boolean values. */
function scrubJson(value: unknown): unknown {
  if (typeof value === 'string') return scrubSecrets(value);
  if (Array.isArray(value)) return value.map(scrubJson);
  if (value && typeof value === 'object') {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const secretField = isSecretKeyName(key)
        && (typeof nested === 'string' || typeof nested === 'number' || typeof nested === 'boolean');
      scrubbed[scrubSecrets(key)] = secretField ? '[REDACTED]' : scrubJson(nested);
    }
    return scrubbed;
  }
  return value;
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

    const rawStdout = asText(result.stdout);
    const helperStderr = scrubSecrets(asText(result.stderr)).trim();
    const parsed = parseUpstream(rawStdout);
    const upstream = parsed ? (scrubJson(parsed) as Record<string, unknown>) : undefined;
    const upstreamOutput = parsed ? undefined : scrubSecrets(rawStdout).trim() || undefined;
    const issueUrl = typeof upstream?.issueUrl === 'string' ? upstream.issueUrl : undefined;
    const shared = { helperStatus: result.status, ...(helperStderr ? { helperStderr } : {}) };

    if (result.status === null) {
      const reason = result.signal ? `signal ${result.signal}` : 'no exit status';
      return {
        receipt,
        exitCode: signalExitCode(result.signal),
        delivered: false,
        channel: binary,
        error: `Helper ${binary} terminated by ${reason}`,
        spooled: false,
        ...shared,
        ...(upstream ? { upstream } : {}),
        ...(upstreamOutput ? { upstreamOutput } : {}),
      };
    }

    if (result.status === 0) {
      return {
        receipt,
        exitCode: 0,
        delivered: true,
        channel: binary,
        spooled: false,
        ...shared,
        ...(upstream ? { upstream } : {}),
        ...(issueUrl ? { issueUrl } : {}),
        ...(upstreamOutput ? { upstreamOutput } : {}),
      };
    }

    const detail = helperStderr || upstreamOutput || `Helper ${binary} exited with status ${result.status}`;
    return {
      receipt,
      exitCode: result.status,
      delivered: false,
      channel: binary,
      error: detail,
      spooled: false,
      ...shared,
      ...(upstream ? { upstream } : {}),
      ...(upstreamOutput ? { upstreamOutput } : {}),
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
          ...(outcome.upstreamOutput ? { upstreamOutput: outcome.upstreamOutput } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
          delivered: outcome.delivered,
          channel: outcome.channel,
          spooled: outcome.spooled,
          ...(outcome.spoolWarning ? { spoolWarning: outcome.spoolWarning } : {}),
        };

        const helperFinished = outcome.helperStatus === 0 || outcome.helperStatus === null;
        if (helperFinished && outcome.helperStderr && outcome.helperStderr !== outcome.error) {
          process.stderr.write(`${outcome.helperStderr}\n`);
        }

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
