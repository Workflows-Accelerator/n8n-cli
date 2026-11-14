import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, spawnSync } from 'child_process';
import {
  KINDS,
  REPO,
  parseExitCode,
  submitFeedback,
  validateKind,
  scrubSecrets,
  type Runner,
  type RunnerResult,
} from '../src/commands/feedback.js';

function enoent(command: string): Error {
  return Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' });
}

function runnerError(command: string, code: string): Error {
  return Object.assign(new Error(`spawn ${command} ${code}`), { code });
}

function recordingRunner(responses: Record<string, RunnerResult> = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: Runner = (command, args) => {
    calls.push({ command, args });
    return responses[command] ?? { status: null, error: enoent(command) };
  };
  return { calls, runner };
}

function argOf(args: string[], flag: string): string | undefined {
  return args[args.indexOf(flag) + 1];
}

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    encoding: 'utf-8',
    env,
  });
}

function runCliCaptured(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    encoding: 'utf-8',
    env,
  });
}

function withSpool<T>(spool: string | undefined, run: () => T): T {
  const previous = process.env.OC_FEEDBACK_SPOOL_FILE;
  if (spool === undefined) delete process.env.OC_FEEDBACK_SPOOL_FILE;
  else process.env.OC_FEEDBACK_SPOOL_FILE = spool;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.OC_FEEDBACK_SPOOL_FILE;
    else process.env.OC_FEEDBACK_SPOOL_FILE = previous;
  }
}

describe('n8ncli feedback: helper delegation', () => {
  it('forwards the full payload to oc-feedback and propagates success', () => {
    const { calls, runner } = recordingRunner({ 'oc-feedback': { status: 0 } });

    const outcome = submitFeedback({
      message: 'missing node support',
      kind: 'missing-capability',
      command: 'n8ncli nodes list',
      note: 'happens every run',
      exitCode: 7,
      json: true,
    }, '1.2.45', runner);

    assert.equal(outcome.delivered, true);
    assert.equal(outcome.channel, 'oc-feedback');
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.spooled, false);
    assert.equal(calls.length, 1);

    const [call] = calls;
    assert.equal(call.command, 'oc-feedback');
    assert.equal(argOf(call.args, '--repo'), REPO);
    assert.equal(argOf(call.args, '--repo'), 'Workflows-Accelerator/n8n-cli');
    assert.equal(argOf(call.args, '--cli'), 'n8ncli');
    assert.equal(argOf(call.args, '--version'), '1.2.45');
    assert.equal(argOf(call.args, '--kind'), 'missing-capability');
    assert.equal(argOf(call.args, '--message'), 'missing node support');
    assert.equal(argOf(call.args, '--command'), 'n8ncli nodes list');
    assert.equal(argOf(call.args, '--note'), 'happens every run');
    assert.equal(argOf(call.args, '--exit-code'), '7');
    assert.ok(call.args.includes('--json'));

    assert.equal(outcome.receipt.repo, REPO);
    assert.equal(outcome.receipt.version, '1.2.45');
    assert.equal(outcome.receipt.kind, 'missing-capability');
    assert.equal(outcome.receipt.exit_code, 7);
  });

  it('propagates a non-zero helper exit code as a failed, undelivered receipt', () => {
    const { runner } = recordingRunner({ 'oc-feedback': { status: 2, stderr: 'usage: bad flag\n' } });
    const outcome = submitFeedback({ message: 'boom' }, '1.2.45', runner);
    assert.equal(outcome.delivered, false);
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.channel, 'oc-feedback');
    assert.equal(outcome.error, 'usage: bad flag');
  });

  it('passes hostile message text as a single argv token with no shell interpretation', () => {
    const { calls, runner } = recordingRunner({ 'oc-feedback': { status: 0 } });
    const hostile = 'crash; rm -rf / #$(whoami) `id`';
    submitFeedback({ message: hostile }, '1.2.45', runner);
    assert.equal(argOf(calls[0].args, '--message'), hostile);
    assert.equal(calls[0].args.filter(arg => arg === hostile).length, 1);
  });
});

describe('n8ncli feedback: helper failures and signals', () => {
  it('falls back to oc-cli-feedback when oc-feedback fails with EACCES', () => {
    const { calls, runner } = recordingRunner({
      'oc-feedback': { status: null, error: runnerError('oc-feedback', 'EACCES') },
      'oc-cli-feedback': { status: 0 },
    });

    const outcome = submitFeedback({ message: 'docs gap', kind: 'docs' }, '1.2.45', runner);

    assert.deepEqual(calls.map(call => call.command), ['oc-feedback', 'oc-cli-feedback']);
    assert.equal(outcome.delivered, true);
    assert.equal(outcome.channel, 'oc-cli-feedback');
    assert.equal(outcome.exitCode, 0);
  });

  it('falls back to oc-cli-feedback when oc-feedback fails with ENOEXEC', () => {
    const { calls, runner } = recordingRunner({
      'oc-feedback': { status: null, error: runnerError('oc-feedback', 'ENOEXEC') },
      'oc-cli-feedback': { status: 0 },
    });

    const outcome = submitFeedback({ message: 'docs gap' }, '1.2.45', runner);

    assert.deepEqual(calls.map(call => call.command), ['oc-feedback', 'oc-cli-feedback']);
    assert.equal(outcome.delivered, true);
    assert.equal(outcome.channel, 'oc-cli-feedback');
  });

  it('reports a signal-killed helper as a failure instead of success', () => {
    const { calls, runner } = recordingRunner({ 'oc-feedback': { status: null, signal: 'SIGKILL' } });

    const outcome = submitFeedback({ message: 'crash' }, '1.2.45', runner);

    assert.deepEqual(calls.map(call => call.command), ['oc-feedback']);
    assert.equal(outcome.delivered, false);
    assert.equal(outcome.exitCode, 137);
    assert.equal(outcome.channel, 'oc-feedback');
    assert.equal(outcome.error, 'Helper oc-feedback terminated by signal SIGKILL');
  });

  it('reports a status-less helper without a signal as exit code 1', () => {
    const { runner } = recordingRunner({ 'oc-feedback': { status: null, signal: null } });
    const outcome = submitFeedback({ message: 'crash' }, '1.2.45', runner);
    assert.equal(outcome.delivered, false);
    assert.equal(outcome.exitCode, 1);
    assert.match(outcome.error ?? '', /terminated by no exit status/);
  });
});

describe('n8ncli feedback: helper output propagation', () => {
  it('parses helper JSON stdout into the receipt', () => {
    const { runner } = recordingRunner({
      'oc-feedback': { status: 0, stdout: '{"issueUrl":"https://example.test/issues/7","id":7}\n' },
    });

    const outcome = submitFeedback({ message: 'json passthrough' }, '1.2.45', runner);

    assert.equal(outcome.delivered, true);
    assert.equal(outcome.issueUrl, 'https://example.test/issues/7');
    assert.equal(outcome.upstream?.id, 7);
    assert.equal(outcome.upstreamOutput, undefined);
  });

  it('parses raw helper JSON before scrubbing so structure and issueUrl survive', () => {
    const stdout = JSON.stringify({
      issueUrl: 'https://example.test/issues/9',
      id: 9,
      message: 'TOKEN: abc123',
      diagnostics: { note: 'token ghp_jsonleak1', bearer: 'Bearer abc.def' },
      tags: ['sk-live_1', 'plain'],
    });
    const { runner } = recordingRunner({ 'oc-feedback': { status: 0, stdout: `${stdout}\n` } });

    const outcome = submitFeedback({ message: 'json structure' }, '1.2.45', runner);

    assert.equal(outcome.delivered, true);
    assert.equal(outcome.issueUrl, 'https://example.test/issues/9');
    assert.equal(outcome.upstream?.id, 9);
    assert.equal(outcome.upstreamOutput, undefined);

    const parsed = JSON.parse(JSON.stringify(outcome.upstream));
    assert.equal(parsed.message, 'TOKEN=[REDACTED]');
    assert.equal(parsed.diagnostics.note, 'token ghp_[REDACTED]');
    assert.equal(parsed.diagnostics.bearer, 'Bearer [REDACTED]');
    assert.deepEqual(parsed.tags, ['sk-[REDACTED]', 'plain']);
    assert.equal(JSON.stringify(outcome).includes('ghp_jsonleak1'), false);
    assert.equal(JSON.stringify(outcome).includes('abc123'), false);
  });

  it('keeps non-JSON helper stdout as trimmed text', () => {
    const { runner } = recordingRunner({
      'oc-feedback': { status: 0, stdout: '  Report queued as #42.\n' },
    });

    const outcome = submitFeedback({ message: 'text passthrough' }, '1.2.45', runner);

    assert.equal(outcome.delivered, true);
    assert.equal(outcome.upstreamOutput, 'Report queued as #42.');
    assert.equal(outcome.upstream, undefined);
  });

  it('surfaces scrubbed helper stderr when the helper exits non-zero', () => {
    const { runner } = recordingRunner({
      'oc-feedback': { status: 1, stderr: 'auth failed with ghp_leakedtoken123\n' },
    });

    const outcome = submitFeedback({ message: 'stderr propagation' }, '1.2.45', runner);

    assert.equal(outcome.delivered, false);
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.error?.includes('ghp_leakedtoken123'), false);
    assert.ok(outcome.error?.includes('ghp_[REDACTED]'));
  });
});

describe('n8ncli feedback: fallback chain', () => {
  it('falls back to oc-cli-feedback when oc-feedback is ENOENT', () => {
    const { calls, runner } = recordingRunner({ 'oc-cli-feedback': { status: 0 } });

    const outcome = submitFeedback({
      message: 'docs gap',
      kind: 'docs',
      command: 'n8ncli lint',
      exitCode: 1,
      json: true,
    }, '1.2.45', runner);

    assert.deepEqual(calls.map(call => call.command), ['oc-feedback', 'oc-cli-feedback']);
    assert.equal(outcome.delivered, true);
    assert.equal(outcome.channel, 'oc-cli-feedback');
    assert.equal(outcome.exitCode, 0);

    const args = calls[1].args;
    assert.equal(argOf(args, '--cli'), 'n8ncli');
    assert.equal(argOf(args, '--message'), 'docs gap');
    assert.equal(argOf(args, '--command'), 'n8ncli lint');
    assert.equal(argOf(args, '--exit-code'), '1');
    assert.ok(args.includes('--json'));
    assert.ok(!args.includes('--repo'));
    assert.ok(!args.includes('--version'));
    assert.ok(!args.includes('--kind'));
  });

  it('propagates the oc-cli-feedback exit code', () => {
    const { runner } = recordingRunner({ 'oc-cli-feedback': { status: 4 } });
    const outcome = submitFeedback({ message: 'boom' }, '1.2.45', runner);
    assert.equal(outcome.channel, 'oc-cli-feedback');
    assert.equal(outcome.delivered, false);
    assert.equal(outcome.exitCode, 4);
  });
});

describe('n8ncli feedback: offline receipt', () => {
  it('returns a secret-scrubbed local receipt when neither helper is installed', () => {
    withSpool(undefined, () => {
      const { calls, runner } = recordingRunner();
      const secretMessage = 'token ghp_abc123XYZ and sk-live_456 for Bearer topsecret at https://user:pass@example.com/hook';

      const outcome = submitFeedback({ message: secretMessage, kind: 'bug' }, '1.2.45', runner);

      assert.deepEqual(calls.map(call => call.command), ['oc-feedback', 'oc-cli-feedback']);
      assert.equal(outcome.delivered, false);
      assert.equal(outcome.channel, 'local-receipt');
      assert.equal(outcome.exitCode, 0);
      assert.equal(outcome.spooled, false);
      assert.equal(outcome.receipt.message.includes('ghp_abc123XYZ'), false);
      assert.equal(outcome.receipt.message.includes('sk-live_456'), false);
      assert.equal(outcome.receipt.message.includes('topsecret'), false);
      assert.equal(outcome.receipt.message.includes('user:pass'), false);
      assert.ok(outcome.receipt.message.includes('ghp_[REDACTED]'));
      assert.ok(outcome.receipt.message.includes('sk-[REDACTED]'));
      assert.ok(outcome.receipt.message.includes('Bearer [REDACTED]'));
      assert.ok(outcome.receipt.message.includes('://[REDACTED]@'));
    });
  });

  it('scrubs secrets in the optional command and reports an unwritable spool', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8ncli-feedback-spool-'));
    withSpool(tempDir, () => {
      const { runner } = recordingRunner();
      const outcome = submitFeedback({ message: 'offline', command: 'curl -H "Authorization: Bearer abc123"' }, '1.2.45', runner);
      assert.equal(outcome.delivered, false);
      assert.equal(outcome.spooled, false);
      assert.ok(outcome.spoolWarning);
      assert.equal(outcome.receipt.command?.includes('abc123'), false);
      assert.ok(outcome.receipt.command?.includes('Bearer [REDACTED]'));
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('appends one JSON line per receipt to OC_FEEDBACK_SPOOL_FILE when set', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8ncli-feedback-jsonl-'));
    const spool = path.join(tempDir, 'spool.jsonl');
    withSpool(spool, () => {
      const first = submitFeedback({ message: 'offline bug' }, '1.2.45', recordingRunner().runner);
      const second = submitFeedback({ message: 'offline docs', kind: 'docs' }, '1.2.45', recordingRunner().runner);
      assert.equal(first.spooled, true);
      assert.equal(second.spooled, true);

      const lines = fs.readFileSync(spool, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(lines.length, 2);
      assert.equal(lines[0].message, 'offline bug');
      assert.equal(lines[0].kind, 'bug');
      assert.equal(lines[1].message, 'offline docs');
      assert.equal(lines[1].kind, 'docs');
      assert.equal(lines[1].repo, REPO);
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates missing spool parent directories with a private file mode', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8ncli-feedback-missing-parent-'));
    const spool = path.join(tempDir, 'nested', 'dir', 'spool.jsonl');
    withSpool(spool, () => {
      const outcome = submitFeedback({ message: 'nested spool' }, '1.2.45', recordingRunner().runner);
      assert.equal(outcome.spooled, true);
      assert.equal(outcome.spoolWarning, undefined);
      assert.equal(fs.existsSync(spool), true);
      assert.equal(fs.statSync(spool).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(spool)).mode & 0o777, 0o700);
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('refuses to follow a symlinked spool file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8ncli-feedback-symlink-'));
    const real = path.join(tempDir, 'real.jsonl');
    const link = path.join(tempDir, 'spool.jsonl');
    fs.writeFileSync(real, 'original\n');
    fs.symlinkSync(real, link);
    withSpool(link, () => {
      const outcome = submitFeedback({ message: 'symlink escape' }, '1.2.45', recordingRunner().runner);
      assert.equal(outcome.spooled, false);
      assert.match(outcome.spoolWarning ?? '', /symbolic link/);
      assert.equal(fs.readFileSync(real, 'utf-8'), 'original\n');
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('scrubs every supported secret pattern before writing to the spool', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8ncli-feedback-patterns-'));
    const spool = path.join(tempDir, 'spool.jsonl');
    const rawSecrets = [
      'ghp_abc123DEF',
      'github_pat_11ABCDEFG_abcdefghijklmnop',
      'gho_xyz789ABC',
      'sk-proj-abc_DEF-123',
      'AKIAABCDEFGHIJKLMNOP',
      'topsecretbearer',
      'hunter2pass',
      'n8nsecretvalue',
      'headersecret',
      'jsonsecret',
      'flagsecret',
      'eqsecret',
      'shhh',
    ];
    const message = [
      'token ghp_abc123DEF',
      'pat github_pat_11ABCDEFG_abcdefghijklmnop',
      'oauth gho_xyz789ABC',
      'openai sk-proj-abc_DEF-123',
      'aws AKIAABCDEFGHIJKLMNOP',
      'header Authorization: Bearer topsecretbearer',
      'url https://:hunter2pass@example.com/hook',
      'env N8N_API_KEY=n8nsecretvalue',
      'header X-N8N-API-KEY: headersecret',
      'json "apiKey": "jsonsecret"',
      'flag --access-token flagsecret',
      'flag --token=eqsecret',
      'env MY_SECRET=shhh',
    ].join(' ');
    withSpool(spool, () => {
      const outcome = submitFeedback({ message }, '1.2.45', recordingRunner().runner);
      assert.equal(outcome.spooled, true);
      const written = fs.readFileSync(spool, 'utf-8');
      for (const secret of rawSecrets) assert.equal(written.includes(secret), false, `spool leaked ${secret}`);
      assert.ok(written.includes('[REDACTED]'));
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('scrubs helper stdout and stderr before exposing them', () => {
    const { runner } = recordingRunner({
      'oc-feedback': { status: 0, stdout: '{"issueUrl":"https://example.test/issues/3","token":"ghp_leakedtoken"}' },
    });
    const outcome = submitFeedback({ message: 'stdout scrub' }, '1.2.45', runner);
    assert.equal(outcome.issueUrl, 'https://example.test/issues/3');
    assert.equal(JSON.stringify(outcome).includes('ghp_leakedtoken'), false);
    assert.equal(outcome.upstream?.token, '[REDACTED]');
  });
});

describe('n8ncli feedback: validation', () => {
  it('accepts the documented kinds and rejects anything else', () => {
    assert.deepEqual([...KINDS], ['bug', 'missing-capability', 'docs']);
    assert.equal(validateKind('bug'), 'bug');
    assert.equal(validateKind('missing-capability'), 'missing-capability');
    assert.equal(validateKind('docs'), 'docs');
    assert.throws(
      () => validateKind('nonsense'),
      /Invalid --kind "nonsense"\. Expected one of: bug, missing-capability, docs\./,
    );
  });

  it('refuses to invoke a helper for an invalid kind', () => {
    const { calls, runner } = recordingRunner({ 'oc-feedback': { status: 0 } });
    assert.throws(() => submitFeedback({ message: 'x', kind: 'nonsense' }, '1.2.45', runner), /Invalid --kind/);
    assert.equal(calls.length, 0);
  });

  it('parses only strict integer --exit-code values', () => {
    assert.equal(parseExitCode('0'), 0);
    assert.equal(parseExitCode('-3'), -3);
    assert.equal(parseExitCode(' 7 '), 7);
    assert.throws(() => parseExitCode('notanumber'), /Invalid --exit-code "notanumber"\. Expected an integer\./);
    assert.throws(() => parseExitCode(''), /Expected an integer/);
    assert.throws(() => parseExitCode('1.5'), /Expected an integer/);
  });

  it('exposes scrubbing as a reusable unit', () => {
    assert.equal(scrubSecrets('ghp_abc'), 'ghp_[REDACTED]');
    assert.equal(scrubSecrets('github_pat_11ABC_abc'), 'github_pat_[REDACTED]');
    assert.equal(scrubSecrets('gho_abc123'), 'gho_[REDACTED]');
    assert.equal(scrubSecrets('sk-abc_def-123'), 'sk-[REDACTED]');
    assert.equal(scrubSecrets('AKIAABCDEFGHIJKLMNOP'), 'AKIA[REDACTED]');
    assert.equal(scrubSecrets('Bearer abc.def'), 'Bearer [REDACTED]');
    assert.equal(scrubSecrets('redis://user:pass@host:6379'), 'redis://[REDACTED]@host:6379');
    assert.equal(scrubSecrets('https://:pass@host/hook'), 'https://[REDACTED]@host/hook');
    assert.equal(scrubSecrets('N8N_API_KEY=abc'), 'N8N_API_KEY=[REDACTED]');
    assert.equal(scrubSecrets('"password": "abc"'), '"password": "[REDACTED]"');
    assert.equal(scrubSecrets('--access-token abc'), '--access-token=[REDACTED]');
    assert.equal(scrubSecrets('no secrets here'), 'no secrets here');
  });

  it('anchors the OpenAI-style key pattern so ordinary words are untouched', () => {
    assert.equal(scrubSecrets('task-runner and desk-lamp'), 'task-runner and desk-lamp');
    assert.equal(scrubSecrets('sk-abc123'), 'sk-[REDACTED]');
    assert.equal(scrubSecrets('key=sk-abc123'), 'key=sk-[REDACTED]');
  });
});

describe('n8ncli feedback: CLI integration', () => {
  it('shows kind, note, and json options in --help', () => {
    const stdout = runCli(['feedback', '--help']);
    assert.ok(stdout.includes('--kind'));
    assert.ok(stdout.includes('missing-capability'));
    assert.ok(stdout.includes('--command'));
    assert.ok(stdout.includes('--note'));
    assert.ok(stdout.includes('--exit-code'));
    assert.ok(stdout.includes('--json'));
  });

  it('emits a structured JSON receipt when no helper is on PATH', () => {
    const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'n8ncli-feedback-path-'));
    try {
      const stdout = runCli(
        ['feedback', 'missing node support', '--kind', 'missing-capability', '--json'],
        { ...process.env, PATH: emptyPath, OC_FEEDBACK_SPOOL_FILE: '' },
      );
      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.cli, 'n8ncli');
      assert.equal(parsed.repo, REPO);
      assert.equal(parsed.kind, 'missing-capability');
      assert.equal(parsed.message, 'missing node support');
      assert.equal(parsed.delivered, false);
      assert.equal(parsed.channel, 'local-receipt');
      assert.ok(parsed.version);
      assert.ok(parsed.created_at);
    } finally {
      fs.rmSync(emptyPath, { recursive: true, force: true });
    }
  });

  it('prints helper stdout in text mode', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8ncli-feedback-bin-'));
    try {
      const helper = path.join(binDir, 'oc-feedback');
      fs.writeFileSync(helper, '#!/bin/sh\nprintf \'%s\\n\' "Report queued as #42."\n');
      fs.chmodSync(helper, 0o755);
      const stdout = runCli(['feedback', 'hello'], {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        OC_FEEDBACK_SPOOL_FILE: '',
      });
      assert.ok(stdout.includes('Report queued as #42.'));
      assert.equal(stdout.includes('Feedback delivered via'), false);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('includes upstreamOutput in the --json payload for non-JSON helper stdout', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8ncli-feedback-json-text-'));
    try {
      const helper = path.join(binDir, 'oc-feedback');
      fs.writeFileSync(helper, '#!/bin/sh\nprintf \'%s\\n\' "Report queued as #77."\n');
      fs.chmodSync(helper, 0o755);
      const stdout = runCli(['feedback', 'hello', '--json'], {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        OC_FEEDBACK_SPOOL_FILE: '',
      });
      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.delivered, true);
      assert.equal(parsed.upstreamOutput, 'Report queued as #77.');
      assert.equal(parsed.upstream, undefined);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('forwards scrubbed helper stderr when the helper succeeds', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8ncli-feedback-warn-'));
    try {
      const helper = path.join(binDir, 'oc-feedback');
      fs.writeFileSync(
        helper,
        '#!/bin/sh\necho "warn: retry later with ghp_leakedtoken" >&2\necho "Report queued as #78."\n',
      );
      fs.chmodSync(helper, 0o755);
      const result = runCliCaptured(['feedback', 'hello'], {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        OC_FEEDBACK_SPOOL_FILE: '',
      });
      assert.equal(result.status, 0);
      assert.ok(String(result.stdout).includes('Report queued as #78.'));
      assert.ok(String(result.stderr).includes('warn: retry later with ghp_[REDACTED]'));
      assert.equal(String(result.stderr).includes('ghp_leakedtoken'), false);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('writes scrubbed helper stderr and echoes the helper exit code', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8ncli-feedback-fail-'));
    try {
      const helper = path.join(binDir, 'oc-feedback');
      fs.writeFileSync(helper, '#!/bin/sh\necho "upload failed for ghp_leakedtoken" >&2\nexit 5\n');
      fs.chmodSync(helper, 0o755);
      try {
        runCli(['feedback', 'hello'], {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          OC_FEEDBACK_SPOOL_FILE: '',
        });
        assert.fail('Expected the helper exit code');
      } catch (err: any) {
        assert.equal(err.status, 5);
        assert.ok(String(err.stderr).includes('ghp_[REDACTED]'));
        assert.equal(String(err.stderr).includes('ghp_leakedtoken'), false);
        assert.equal(String(err.stdout).includes('Feedback delivered'), false);
      }
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('exits 2 for a non-integer --exit-code', () => {
    try {
      runCli(['feedback', 'hello', '--exit-code', 'notanumber']);
      assert.fail('Expected a usage error');
    } catch (err: any) {
      assert.equal(err.status, 2);
      assert.ok(String(err.stderr).includes('Invalid --exit-code "notanumber"'));
    }
  });

  it('exits 2 for an empty --exit-code', () => {
    try {
      runCli(['feedback', 'hello', '--exit-code', '']);
      assert.fail('Expected a usage error');
    } catch (err: any) {
      assert.equal(err.status, 2);
      assert.ok(String(err.stderr).includes('Invalid --exit-code'));
    }
  });

  it('exits 1 with a clear error for an invalid --kind', () => {
    try {
      runCli(['feedback', 'hello', '--kind', 'nonsense']);
      assert.fail('Expected non-zero exit for an invalid --kind');
    } catch (err: any) {
      assert.equal(err.status, 1);
      assert.ok(String(err.stderr).includes('Invalid --kind "nonsense"'));
    }
  });
});

describe('n8ncli feedback: scrubber latency', () => {
  const LATENCY_BUDGET_MS = 100;
  const adversarial: Array<[string, string]> = [
    ['URL credentials', `://${'a:'.repeat(25000)}`],
    ['env assignment', `${'A'.repeat(50000)}=`],
    ['OpenAI key prefix', 'sk-'.repeat(12500)],
  ];

  for (const [label, input] of adversarial) {
    it(`scrubs a 50 KB ${label} payload in under ${LATENCY_BUDGET_MS} ms`, () => {
      const started = performance.now();
      scrubSecrets(input);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < LATENCY_BUDGET_MS, `${label} scrub took ${elapsed.toFixed(1)} ms for ${input.length} bytes`);
    });
  }
});
