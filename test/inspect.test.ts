import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { inspectWorkflow, formatTopologyOutput, formatNodeOutput, extractNodeSnippetFromTs, findConnectionsForNode } from '../src/commands/inspect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const codeTemplatePath = path.resolve(__dirname, '../templates/workflow_examples_ref/Code/Code Template.workflow.ts');

describe('n8ncli inspect: Core Logic and Resolution', () => {
  it('inspects a local workflow by direct file path', async () => {
    const result = await inspectWorkflow({
      target: codeTemplatePath,
    });

    assert.equal(result.id, 'tK55D0eyhgRZLMnt');
    assert.equal(result.name, 'Code Template');
    assert.ok(Array.isArray(result.nodes));
    assert.equal(result.nodes.length, 5);
    assert.ok(result.tsCode);
    assert.ok(result.tsCode.includes('Code Template'));
    assert.ok(result.triggers.includes('Start Trigger'));
  });

  it('formats compact TypeScript-first topological output for default view', async () => {
    const result = await inspectWorkflow({
      target: codeTemplatePath,
    });

    const outputText = formatTopologyOutput(result);
    assert.ok(outputText.includes('Workflow: Code Template'));
    assert.ok(outputText.includes('ID: tK55D0eyhgRZLMnt'));
    assert.ok(outputText.includes('Start Trigger (n8n-nodes-base.manualTrigger v1)'));
    assert.ok(outputText.includes('Run Once For Each (n8n-nodes-base.code v2)'));
    // Checks that directed connections are rendered
    assert.ok(outputText.includes('->'));
    // Checks that code summary is visible
    assert.ok(outputText.includes('jsCode:'));
    // Ensure compact output (< 60 lines)
    const lineCount = outputText.trim().split('\n').length;
    assert.ok(lineCount <= 60, `Output line count was ${lineCount}, expected <= 60`);
  });

  it('extracts specific node block and connections with --node option', async () => {
    const result = await inspectWorkflow({
      target: codeTemplatePath,
      node: 'Run Once For Each',
    });

    assert.equal(result.name, 'Code Template');
    assert.ok(result.targetNode);
    assert.equal(result.targetNode.name, 'Run Once For Each');
    assert.equal(result.targetNode.type, 'n8n-nodes-base.code');
    // tsCode should be scoped to that node's declaration
    assert.ok(result.tsCode.includes("name: 'Run Once For Each'"));
    assert.ok(result.tsCode.includes('runOnceForEachItem'));
    assert.ok(!result.tsCode.includes("name: 'Run Once For All'"));

    const outputText = formatNodeOutput(result);
    assert.ok(outputText.includes('Node:     Run Once For Each'));
    assert.ok(outputText.includes('Upstream:'));
    assert.ok(outputText.includes('Split Items'));
    assert.ok(outputText.includes('Downstream:'));
    assert.ok(outputText.includes('Run Once For All'));
    assert.ok(outputText.includes('TypeScript SDK Declaration:'));
    assert.ok(outputText.includes('runOnceForEachItem'));
  });

  it('fails with clear error listing available node names when --node does not match', async () => {
    await assert.rejects(
      async () => {
        await inspectWorkflow({
          target: codeTemplatePath,
          node: 'NonExistentNode',
        });
      },
      (err: any) => {
        assert.ok(err.message.includes('Node "NonExistentNode" not found in workflow "Code Template"'));
        assert.ok(err.message.includes('Available nodes:'));
        assert.ok(err.message.includes('Start Trigger'));
        assert.ok(err.message.includes('Run Once For Each'));
        return true;
      }
    );
  });

  it('produces valid structured JSON in --json mode', async () => {
    const result = await inspectWorkflow({
      target: codeTemplatePath,
    });

    const jsonPayload = {
      id: result.id,
      name: result.name,
      active: result.active,
      triggers: result.triggers,
      nodes: result.nodes,
      connections: result.connections,
      tsCode: result.tsCode,
    };

    const serialized = JSON.stringify(jsonPayload);
    const parsed = JSON.parse(serialized);
    assert.equal(parsed.id, 'tK55D0eyhgRZLMnt');
    assert.equal(parsed.name, 'Code Template');
    assert.ok(Array.isArray(parsed.nodes));
    assert.ok(parsed.tsCode);
    assert.ok(typeof parsed.connections === 'object');
  });

  it('scopes tsCode to targeted node in --json mode with --node option', async () => {
    const result = await inspectWorkflow({
      target: codeTemplatePath,
      node: 'Run Once For All',
    });

    assert.ok(result.tsCode.includes("name: 'Run Once For All'"));
    assert.ok(result.tsCode.includes('totalSum'));
    assert.ok(!result.tsCode.includes("name: 'Run Once For Each'"));
  });

  it('inspects remote workflow in memory without writing to disk', async () => {
    // Mock getWorkflowDetails
    const mockRemoteWorkflow = {
      id: 'remote-wf-999',
      name: 'Remote In-Memory Flow',
      active: true,
      nodes: [
        {
          name: 'Schedule Trigger',
          type: 'n8n-nodes-base.scheduleTrigger',
          typeVersion: 1.2,
          position: [100, 100],
          parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } },
        },
        {
          name: 'Transform Code',
          type: 'n8n-nodes-base.code',
          typeVersion: 2,
          position: [300, 100],
          parameters: { jsCode: 'return [{ json: { ok: true } }];' },
        },
      ],
      connections: {
        'Schedule Trigger': {
          main: [[{ node: 'Transform Code', type: 'main', index: 0 }]],
        },
      },
    };

    let fetchCalled = false;
    const mockFetcher = async (id: string) => {
      fetchCalled = true;
      assert.equal(id, 'remote-wf-999');
      return mockRemoteWorkflow;
    };

    const result = await inspectWorkflow({
      target: 'remote-wf-999',
      fetchRemoteDetails: mockFetcher,
    });

    assert.equal(fetchCalled, true);
    assert.equal(result.id, 'remote-wf-999');
    assert.equal(result.name, 'Remote In-Memory Flow');
    assert.equal(result.nodes.length, 2);
    assert.ok(result.tsCode.includes('Remote In-Memory Flow'));
    assert.ok(result.tsCode.includes('Transform Code'));
  });

  describe('Adversarial TS Scanner: extractNodeSnippetFromTs', () => {
    it('handles unbalanced braces, regex, template literals, comments, and fake node() in jsCode', () => {
      const adversarialSource = `
import { node, trigger, workflow } from '@n8n/workflow-sdk'

// const fake_comment = node({ config: { name: 'Real Target Node' } });

const fake_node = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Fake Code Node',
    parameters: {
      assignments: { assignments: [{ id: '1', name: 'Real Target Node' }] },
      jsCode: "// { ( unbalanced brackets\\nconst fake = node({ name: 'Real Target Node' });\\nconst regex = /[{()]/;\\nconst semi = 1; return [{ json: { ok: true } }];"
    }
  }
});

const real_node = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    // name: 'Wrong Name In Comment'
    name: 'Real Target Node',
    parameters: {
      jsCode: "const a = 10 / 2; return [{ json: { real: true } }];"
    }
  }
});
`;

      const snippet = extractNodeSnippetFromTs(adversarialSource, 'Real Target Node');
      assert.ok(snippet, 'Expected non-null snippet');
      assert.ok(snippet.includes("name: 'Real Target Node'"));
      assert.ok(snippet.includes('const a = 10 / 2;'));
      // Must not contain fake_node or fake_comment
      assert.ok(!snippet.includes('Fake Code Node'));
      assert.ok(!snippet.includes('unbalanced brackets'));
      assert.ok(!snippet.includes('fake_comment'));
    });

    it('extracts node with escaped quotes and regex characters in name', () => {
      const sourceWithEscapes = `
const special = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4,
  config: {
    name: 'O\\'Reilly (v2.0) [Test]',
    parameters: { url: 'https://example.com' }
  }
});
`;
      const snippet = extractNodeSnippetFromTs(sourceWithEscapes, "O'Reilly (v2.0) [Test]");
      assert.ok(snippet, 'Snippet should be found');
      assert.ok(snippet.includes("O\\'Reilly (v2.0) [Test]"));
      assert.ok(snippet.includes('https://example.com'));
    });

    it('extracts node declared without trailing semicolon (ASI)', () => {
      const sourceNoSemi = `
const first = node({
  type: 'n8n-nodes-base.set',
  version: 1,
  config: { name: 'First Node' }
})

const second = node({
  type: 'n8n-nodes-base.set',
  version: 1,
  config: { name: 'Second Node' }
})
`;
      const snippet = extractNodeSnippetFromTs(sourceNoSemi, 'First Node');
      assert.ok(snippet);
      assert.ok(snippet.includes('First Node'));
      assert.ok(!snippet.includes('Second Node'));
    });
  });

  describe('Local .json Workflow File Input (In-Memory with Zero Disk Writes)', () => {
    it('inspects local .json workflow file in memory without writing .workflow.ts or deleting .json', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8ncli-inspect-json-'));
      const jsonFilePath = path.join(tempDir, 'legacy-sample.json');
      const expectedTsPath = path.join(tempDir, 'legacy-sample.workflow.ts');

      const mockJson = {
        id: 'json-legacy-123',
        name: 'Legacy JSON Workflow',
        active: false,
        nodes: [
          {
            name: 'Start',
            type: 'n8n-nodes-base.manualTrigger',
            typeVersion: 1,
            position: [200, 300],
            parameters: {},
          },
          {
            name: 'Process',
            type: 'n8n-nodes-base.code',
            typeVersion: 2,
            position: [400, 300],
            parameters: { jsCode: 'return [{ json: { processed: true } }];' },
          },
        ],
        connections: {
          Start: {
            main: [[{ node: 'Process', type: 'main', index: 0 }]],
          },
        },
      };

      fs.writeFileSync(jsonFilePath, JSON.stringify(mockJson, null, 2), 'utf-8');

      try {
        const result = await inspectWorkflow({
          target: jsonFilePath,
        });

        assert.equal(result.id, 'json-legacy-123');
        assert.equal(result.name, 'Legacy JSON Workflow');
        assert.equal(result.nodes.length, 2);
        assert.ok(result.tsCode.includes('Legacy JSON Workflow'));
        assert.ok(result.tsCode.includes('Process'));

        // Zero disk writes verification
        assert.ok(fs.existsSync(jsonFilePath), 'Original .json file must not be deleted');
        assert.ok(!fs.existsSync(expectedTsPath), 'No .workflow.ts file should be created on disk');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Token Bloat Prevention in --json Mode', () => {
    it('omits raw parameters from non-targeted nodes in nodes list', async () => {
      const result = await inspectWorkflow({
        target: codeTemplatePath,
        json: true,
      });

      // result.nodes should be compact metadata: name, type, typeVersion, position, downstream, disabled
      for (const n of result.nodes) {
        assert.equal(n.parameters, undefined, `Node ${n.name} should not contain raw parameters in nodes list`);
        assert.ok(n.name, 'Node must have name');
        assert.ok(n.type, 'Node must have type');
        assert.ok(Array.isArray(n.downstream), 'Node must have downstream connections array');
      }

      // But tsCode carries the full TypeScript representation
      assert.ok(result.tsCode.includes('totalSum'));
    });

    it('includes parameters on targetNode when --node is used while keeping nodes compact', async () => {
      const result = await inspectWorkflow({
        target: codeTemplatePath,
        node: 'Run Once For Each',
        json: true,
      });

      assert.ok(result.targetNode, 'targetNode must be present');
      assert.ok(result.targetNode.parameters, 'targetNode must retain its parameters');
      assert.equal(result.targetNode.parameters.mode, 'runOnceForEachItem');

      // Other nodes in nodes array must NOT duplicate parameters
      for (const n of result.nodes) {
        assert.equal(n.parameters, undefined, `Node ${n.name} in nodes list should not duplicate raw parameters`);
      }
    });
  });

  describe('Topology Formatting: Line Budget, Disabled Nodes, Multi-Branch and Error Connections', () => {
    it('formats disabled nodes and multi-branch/error routing clearly', () => {
      const mockResult = {
        id: 'topo-123',
        name: 'Complex Topology',
        active: true,
        source: 'local' as const,
        triggers: ['Webhook Trigger'],
        nodes: [
          {
            name: 'Webhook Trigger',
            type: 'n8n-nodes-base.webhook',
            typeVersion: 1,
            position: [100, 100] as [number, number],
            downstream: ['Router'],
          },
          {
            name: 'Router',
            type: 'n8n-nodes-base.if',
            typeVersion: 2,
            position: [300, 100] as [number, number],
            downstream: ['Success Handler', 'Failure Handler'],
          },
          {
            name: 'Success Handler',
            type: 'n8n-nodes-base.httpRequest',
            typeVersion: 4,
            position: [500, 0] as [number, number],
            summary: 'url: https://api.example.com/success',
            downstream: [],
          },
          {
            name: 'Failure Handler',
            type: 'n8n-nodes-base.code',
            typeVersion: 2,
            position: [500, 200] as [number, number],
            disabled: true,
            summary: 'jsCode: console.error("failed");',
            downstream: [],
          },
          {
            name: 'Error Monitor',
            type: 'n8n-nodes-base.code',
            typeVersion: 2,
            position: [700, 100] as [number, number],
            downstream: [],
          },
        ],
        connections: {
          'Webhook Trigger': {
            main: [[{ node: 'Router', type: 'main', index: 0 }]],
          },
          'Router': {
            main: [
              [{ node: 'Success Handler', type: 'main', index: 0 }],
              [{ node: 'Failure Handler', type: 'main', index: 0 }],
            ],
          },
          'Success Handler': {
            error: [[{ node: 'Error Monitor', type: 'main', index: 0 }]],
          },
        },
        upstream: [],
        downstream: [],
        tsCode: '',
      };

      const formatted = formatTopologyOutput(mockResult);

      // Verify disabled badge
      assert.ok(formatted.includes('[DISABLED] Failure Handler'), 'Disabled node should have [DISABLED] tag');

      // Verify multi-branch routing
      assert.ok(formatted.includes('main[0]: [Success Handler] | main[1]: [Failure Handler]'), 'Multi-branch IF output should show main[0] and main[1]');

      // Verify error connection routing
      assert.ok(formatted.includes('error: [Error Monitor]'), 'Error connection should be displayed');

      // Verify compact summary lines
      assert.ok(formatted.includes('url: https://api.example.com/success'));
      assert.ok(formatted.includes('jsCode: console.error("failed");'));
    });
  });

  describe('Commander Global Options and CLI Subprocess Integration', () => {
    it('keeps inspect --help output <= 15 lines', () => {
      const stdout = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'inspect', '--help'], {
        encoding: 'utf-8',
      });
      const lines = stdout.trim().split('\n');
      assert.ok(lines.length <= 15, `Expected <= 15 lines in --help, got ${lines.length}:\n${stdout}`);
    });

    it('executes via CLI subprocess in --json mode with global flags', () => {
      const stdout = execFileSync(process.execPath, [
        '--import', 'tsx',
        'src/cli.ts',
        '--json',
        'inspect',
        codeTemplatePath,
      ], {
        encoding: 'utf-8',
      });

      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.id, 'tK55D0eyhgRZLMnt');
      assert.equal(parsed.name, 'Code Template');
      assert.ok(Array.isArray(parsed.nodes));
      assert.ok(parsed.tsCode);
      // Nodes in JSON mode should not contain raw parameters
      for (const n of parsed.nodes) {
        assert.equal(n.parameters, undefined);
      }
    });

    it('forwards global --config option to resolve custom localDir workflows', () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'n8ncli-inspect-config-'));
      const customConfigPath = path.join(tempRoot, 'custom-n8n.json');
      const customWorkflowsDir = path.join(tempRoot, 'custom-workflows-shelf', 'workflows');
      fs.mkdirSync(customWorkflowsDir, { recursive: true });

      const customWorkflowFile = path.join(customWorkflowsDir, 'CustomInvoice.workflow.ts');
      const customCode = `
const start = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Manual Trigger' }
});
const wf = workflow('inv-123', 'CustomInvoice');
export default wf.add(start);
`;
      fs.writeFileSync(customWorkflowFile, customCode, 'utf-8');
      fs.writeFileSync(customConfigPath, JSON.stringify({ localDir: 'custom-workflows-shelf' }), 'utf-8');

      try {
        const stdout = execFileSync(process.execPath, [
          '--import', 'tsx',
          path.resolve(__dirname, '../src/cli.ts'),
          '--config', customConfigPath,
          '--json',
          'inspect',
          'CustomInvoice',
        ], {
          encoding: 'utf-8',
        });

        const parsed = JSON.parse(stdout.trim());
        assert.equal(parsed.name, 'CustomInvoice');
        assert.equal(parsed.id, 'inv-123');
        assert.equal(parsed.nodes.length, 1);
        assert.equal(parsed.nodes[0].name, 'Manual Trigger');
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('forwards --mcp-command, --access-token, and --url via cmd.optsWithGlobals()', () => {
      // Pass a custom mcp-command that outputs a marker to stderr and exits
      // This proves cmd.optsWithGlobals() properly forwarded --mcp-command, --access-token, and --url
      try {
        execFileSync(process.execPath, [
          '--import', 'tsx',
          'src/cli.ts',
          'inspect',
          'remote-wf-id-xyz',
          '--mcp-command', 'node -e "console.error(\'MARKER_MCP_CMD_FORWARDED\'); process.exit(1);"',
          '--access-token', 'valid-test-access-token-123',
          '--url', 'http://127.0.0.1:19999',
        ], {
          encoding: 'utf-8',
          env: {
            ...process.env,
            N8N_ACCESS_TOKEN: '',
            N8N_INSTANCE_URL: '',
            N8N_API_KEY: '',
          },
        });
        assert.fail('Command should have exited non-zero');
      } catch (err: any) {
        const stderr = err.stderr ? String(err.stderr) : '';
        const stdout = err.stdout ? String(err.stdout) : '';
        const combined = stderr + stdout + (err.message || '');
        assert.ok(
          combined.includes('MARKER_MCP_CMD_FORWARDED') || combined.includes('Failed to start MCP server'),
          `Expected evidence of MCP command invocation, got:\n${combined}`
        );
      }
    });
  });

  describe('Hostile Stress Tests: Node Classification, Line Budget & Exact Matching', () => {
    it('classifies respondToWebhook as regular node, not trigger', async () => {
      const webhookWf = {
        name: 'Webhook Response Test',
        nodes: [
          {
            name: 'Webhook Call',
            type: 'n8n-nodes-base.webhook',
            typeVersion: 2,
            position: [100, 100],
            parameters: { path: 'test' },
          },
          {
            name: 'Respond To Call',
            type: 'n8n-nodes-base.respondToWebhook',
            typeVersion: 1,
            position: [300, 100],
            parameters: { options: {} },
          },
        ],
        connections: {
          'Webhook Call': {
            main: [[{ node: 'Respond To Call', type: 'main', index: 0 }]],
          },
        },
      };

      const result = await inspectWorkflow({
        target: 'mock-webhook-target',
        fetchRemoteDetails: async () => webhookWf,
      });

      assert.deepEqual(result.triggers, ['Webhook Call']);
      assert.ok(!result.triggers.includes('Respond To Call'));
    });

    it('stays strictly within line budget for a 50-node workflow', async () => {
      const bigWfNodes: any[] = [];
      const bigWfConns: Record<string, any> = {};

      for (let i = 1; i <= 50; i++) {
        const name = `Step ${i}`;
        const isCode = i % 2 === 0;
        bigWfNodes.push({
          name,
          type: isCode ? 'n8n-nodes-base.code' : 'n8n-nodes-base.httpRequest',
          typeVersion: 1,
          position: [i * 100, 100],
          parameters: isCode
            ? { jsCode: `// 50 lines of complex script code\nreturn [{ json: { step: ${i} } }];` }
            : { url: `https://api.service.internal/v1/resource/${i}?filter=active&sort=desc` },
        });

        if (i < 50) {
          bigWfConns[name] = {
            main: [[{ node: `Step ${i + 1}`, type: 'main', index: 0 }]],
          };
        }
      }

      const result = await inspectWorkflow({
        target: '50-node-workflow',
        fetchRemoteDetails: async () => ({
          id: 'fifty-node-wf',
          name: 'Big 50 Node Workflow',
          active: true,
          nodes: bigWfNodes,
          connections: bigWfConns,
        }),
      });

      const formatted = formatTopologyOutput(result);
      const lineCount = formatted.trim().split('\n').length;
      // 50 nodes * 2 lines max + headers (5 lines) <= 110 lines
      assert.ok(lineCount <= 110, `Expected topology <= 110 lines for 50 nodes, got ${lineCount}`);
    });

    it('prioritizes exact basename match over substring match in workflowsDir', async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'n8ncli-inspect-exact-'));
      const workflowsDir = path.join(tempRoot, 'n8n', 'workflows');
      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.mkdirSync(path.join(tempRoot, 'n8n', 'config'), { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'n8n', 'config', 'n8n-cli.json'), JSON.stringify({ localDir: 'n8n' }), 'utf-8');

      // Create two workflows: 'Test Workflow V2' and 'Test'
      const wfV2 = `
const n1 = node({ type: 'n8n-nodes-base.set', version: 1, config: { name: 'Node V2' } });
const wf = workflow('v2-id', 'Test Workflow V2');
export default wf.add(n1);
`;
      const wfExact = `
const n1 = node({ type: 'n8n-nodes-base.set', version: 1, config: { name: 'Node Exact' } });
const wf = workflow('exact-id', 'Test');
export default wf.add(n1);
`;
      fs.writeFileSync(path.join(workflowsDir, 'Test Workflow V2.workflow.ts'), wfV2, 'utf-8');
      fs.writeFileSync(path.join(workflowsDir, 'Test.workflow.ts'), wfExact, 'utf-8');

      try {
        const result = await inspectWorkflow({
          target: 'Test',
          config: path.join(tempRoot, 'n8n', 'config', 'n8n-cli.json'),
        });

        // Must resolve 'Test', NOT 'Test Workflow V2'
        assert.equal(result.name, 'Test');
        assert.equal(result.id, 'exact-id');
        assert.equal(result.nodes[0].name, 'Node Exact');
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });
});
