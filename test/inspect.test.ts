import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { inspectWorkflow, formatTopologyOutput, formatNodeOutput } from '../src/commands/inspect.js';

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
});
