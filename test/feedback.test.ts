import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { KINDS, REPO, submitFeedback, validateKind, scrubSecrets, type Runner } from '../src/commands/feedback.js';

function enoent(command: string): Error {
  return Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' });
}

function recordingRunner(responses: Record<string, { status: number | null; error?: Error | null }> = {}) {
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

describe('n8ncli feedback: helper delegation', () => {
  it('forwards the full payload to oc-feedback and propagates success', () => {
    const { calls, runner } = recordingRunner({ 'oc-feedback': { status: 0 } });

    const outcome = submitFeedback({
      message: 'missing node support',
      kind: 'missing-capability',
      command: 'n8ncli nodes list',
      exitCode: 7,
      json: true,
    }, '1.2.45', runner);

    assert.equal(outcome.delivered, true);
    assert.equal(outcome.channel, 'oc-feedback');
    assert.equal(outcome.exitCode, 0);
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
    assert.equal(argOf(call.args, '--exit-code'), '7');
    assert.ok(call.args.includes('--json'));

    assert.equal(outcome.receipt.repo, REPO);
    assert.equal(outcome.receipt.version, '1.2.45');
    assert.equal(outcome.receipt.kind, 'missing-capability');
    assert.equal(outcome.receipt.exit_code, 7);
  });

  it('propagates the helper exit code instead of masking it', () => {
    const { runner } = recordingRunner({ 'oc-feedback': { status: 2 } });
    const outcome = submitFeedback({ message: 'boom' }, '1.2.45', runner);
    assert.equal(outcome.delivered, true);
    assert.equal(outcome.exitCode, 2);
  });

  it('passes hostile message text as a single argv token with no shell interpretation', () => {
    const { calls, runner } = recordingRunner({ 'oc-feedback': { status: 0 } });
    const hostile = 'crash; rm -rf / #$(whoami) `id`';
    submitFeedback({ message: hostile }, '1.2.45', runner);
    assert.equal(argOf(calls[0].args, '--message'), hostile);
    assert.equal(calls[0].args.filter(arg => arg === hostile).length, 1);
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
    assert.equal(outcome.exitCode, 4);
  });
});

describe('n8ncli feedback: offline receipt', () => {
  it('returns a secret-scrubbed local receipt when neither helper is installed', () => {
    const previousSpool = process.env.OC_FEEDBACK_SPOOL_FILE;
    delete process.env.OC_FEEDBACK_SPOOL_FILE;
    try {
      const { calls, runner } = recordingRunner();
      const secretMessage = 'token ghp_abc123XYZ and sk-live_456 for Bearer topsecret at https://user:pass@example.com/hook';

      const outcome = submitFeedback({ message: secretMessage, kind: 'bug' }, '1.2.45', runner);

      assert.deepEqual(calls.map(call => call.command), ['oc-feedback', 'oc-cli-feedback']);
      assert.equal(outcome.delivered, false);
      assert.equal(outcome.channel, 'local-receipt');
      assert.equal(outcome.exitCode, 0);
      assert.equal(outcome.receipt.message.includes('ghp_abc123XYZ'), false);
      assert.equal(outcome.receipt.message.includes('sk-live_456'), false);
      assert.equal(outcome.receipt.message.includes('topsecret'), false);
      assert.equal(outcome.receipt.message.includes('user:pass'), false);
      assert.ok(outcome.receipt.message.includes('ghp_[REDACTED]'));
      assert.ok(outcome.receipt.message.includes('sk-[REDACTED]'));
      assert.ok(outcome.receipt.message.includes('Bearer [REDACTED]'));
      assert.ok(outcome.receipt.message.includes('://[REDACTED]@'));
    } finally {
      if (previousSpool === undefined) delete process.env.OC_FEEDBACK_SPOOL_FILE;
      else process.env.OC_FEEDBACK_SPOOL_FILE = previousSpool;
    }
  });

  it('scrubs secrets in the optional command and never throws on an unwritable spool', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8ncli-feedback-spool-'));
    const previousSpool = process.env.OC_FEEDBACK_SPOOL_FILE;
    process.env.OC_FEEDBACK_SPOOL_FILE = tempDir;
    try {
      const { runner } = recordingRunner();
      const outcome = submitFeedback({ message: 'offline', command: 'curl -H "Authorization: Bearer abc123"' }, '1.2.45', runner);
      assert.equal(outcome.delivered, false);
      assert.equal(outcome.receipt.command?.includes('abc123'), false);
      assert.ok(outcome.receipt.command?.includes('Bearer [REDACTED]'));
    } finally {
      if (previousSpool === undefined) delete process.env.OC_FEEDBACK_SPOOL_FILE;
      else process.env.OC_FEEDBACK_SPOOL_FILE = previousSpool;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('appends one JSON line per receipt to OC_FEEDBACK_SPOOL_FILE when set', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8ncli-feedback-jsonl-'));
    const spool = path.join(tempDir, 'spool.jsonl');
    const previousSpool = process.env.OC_FEEDBACK_SPOOL_FILE;
    process.env.OC_FEEDBACK_SPOOL_FILE = spool;
    try {
      submitFeedback({ message: 'offline bug' }, '1.2.45', recordingRunner().runner);
      submitFeedback({ message: 'offline docs', kind: 'docs' }, '1.2.45', recordingRunner().runner);

      const lines = fs.readFileSync(spool, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(lines.length, 2);
      assert.equal(lines[0].message, 'offline bug');
      assert.equal(lines[0].kind, 'bug');
      assert.equal(lines[1].message, 'offline docs');
      assert.equal(lines[1].kind, 'docs');
      assert.equal(lines[1].repo, REPO);
    } finally {
      if (previousSpool === undefined) delete process.env.OC_FEEDBACK_SPOOL_FILE;
      else process.env.OC_FEEDBACK_SPOOL_FILE = previousSpool;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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

  it('exposes scrubbing as a reusable unit', () => {
    assert.equal(scrubSecrets('ghp_abc'), 'ghp_[REDACTED]');
    assert.equal(scrubSecrets('sk-abc_def-123'), 'sk-[REDACTED]');
    assert.equal(scrubSecrets('Bearer abc.def'), 'Bearer [REDACTED]');
    assert.equal(scrubSecrets('redis://user:pass@host:6379'), 'redis://[REDACTED]@host:6379');
    assert.equal(scrubSecrets('no secrets here'), 'no secrets here');
  });
});

describe('n8ncli feedback: CLI integration', () => {
  it('shows kind and json options in --help', () => {
    const stdout = runCli(['feedback', '--help']);
    assert.ok(stdout.includes('--kind'));
    assert.ok(stdout.includes('missing-capability'));
    assert.ok(stdout.includes('--command'));
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
      assert.ok(parsed.version);
      assert.ok(parsed.created_at);
    } finally {
      fs.rmSync(emptyPath, { recursive: true, force: true });
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
