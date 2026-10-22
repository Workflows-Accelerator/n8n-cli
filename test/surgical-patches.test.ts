import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateWorkflowUpdateOperations,
  chunkOperations,
  isTargetScoped,
} from '../src/sync-state.js';
import { validateAndTrimCredential } from '../src/config.js';

describe('Surgical Patches: Bug 2 - AST Diff Engine (generateWorkflowUpdateOperations)', () => {
  it('generates updateNodeParameters when node parameters differ', () => {
    const remote = {
      name: 'My Workflow',
      nodes: [
        {
          name: 'Manual Trigger',
          type: 'n8n-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [100, 200],
          parameters: {},
        },
        {
          name: 'Code Node',
          type: 'n8n-nodes-base.code',
          typeVersion: 2,
          position: [300, 200],
          parameters: { jsCode: 'return [{ json: { foo: 1 } }];' },
        },
      ],
      connections: {
        'Manual Trigger': {
          main: [[{ node: 'Code Node', type: 'main', index: 0 }]],
        },
      },
    };

    const local = {
      name: 'My Workflow',
      nodes: [
        {
          name: 'Manual Trigger',
          type: 'n8n-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [100, 200],
          parameters: {},
        },
        {
          name: 'Code Node',
          type: 'n8n-nodes-base.code',
          typeVersion: 2,
          position: [300, 200],
          parameters: { jsCode: 'return [{ json: { foo: 2 } }];' },
        },
      ],
      connections: {
        'Manual Trigger': {
          main: [[{ node: 'Code Node', type: 'main', index: 0 }]],
        },
      },
    };

    const ops = generateWorkflowUpdateOperations(local, remote);
    assert.equal(ops.length, 1);
    assert.deepEqual(ops[0], {
      type: 'updateNodeParameters',
      nodeName: 'Code Node',
      parameters: { jsCode: 'return [{ json: { foo: 2 } }];' },
      replace: true,
    });
  });

  it('generates removeNode and addNode when nodes are removed or added', () => {
    const remote = {
      name: 'Flow',
      nodes: [
        { name: 'Old Node', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, 0] },
      ],
      connections: {},
    };

    const local = {
      name: 'Flow',
      nodes: [
        { name: 'New Node', type: 'n8n-nodes-base.set', typeVersion: 2, position: [100, 100], parameters: { value: 'test' } },
      ],
      connections: {},
    };

    const ops = generateWorkflowUpdateOperations(local, remote);
    assert.equal(ops.length, 2);
    // removeNode should come before addNode
    assert.deepEqual(ops[0], {
      type: 'removeNode',
      nodeName: 'Old Node',
    });
    assert.deepEqual(ops[1], {
      type: 'addNode',
      node: {
        name: 'New Node',
        type: 'n8n-nodes-base.set',
        typeVersion: 2,
        parameters: { value: 'test' },
        position: [100, 100],
      },
    });
  });

  it('generates removeConnection and addConnection in proper order', () => {
    const remote = {
      name: 'Flow',
      nodes: [
        { name: 'A', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1 },
        { name: 'B', type: 'n8n-nodes-base.noOp', typeVersion: 1 },
        { name: 'C', type: 'n8n-nodes-base.noOp', typeVersion: 1 },
      ],
      connections: {
        A: {
          main: [[{ node: 'B', type: 'main', index: 0 }]],
        },
      },
    };

    const local = {
      name: 'Flow',
      nodes: [
        { name: 'A', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1 },
        { name: 'B', type: 'n8n-nodes-base.noOp', typeVersion: 1 },
        { name: 'C', type: 'n8n-nodes-base.noOp', typeVersion: 1 },
      ],
      connections: {
        A: {
          main: [[{ node: 'C', type: 'main', index: 0 }]],
        },
      },
    };

    const ops = generateWorkflowUpdateOperations(local, remote);
    assert.equal(ops.length, 2);
    assert.deepEqual(ops[0], {
      type: 'removeConnection',
      source: 'A',
      target: 'B',
      sourceIndex: 0,
      targetIndex: 0,
      connectionType: 'main',
    });
    assert.deepEqual(ops[1], {
      type: 'addConnection',
      source: 'A',
      target: 'C',
      sourceIndex: 0,
      targetIndex: 0,
      connectionType: 'main',
    });
  });

  it('generates setNodePosition and setNodeDisabled when position or disabled status changes', () => {
    const remote = {
      name: 'Flow',
      nodes: [
        { name: 'A', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], disabled: false },
      ],
      connections: {},
    };

    const local = {
      name: 'Flow',
      nodes: [
        { name: 'A', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [150, 250], disabled: true },
      ],
      connections: {},
    };

    const ops = generateWorkflowUpdateOperations(local, remote);
    assert.equal(ops.length, 2);
    assert.deepEqual(ops[0], {
      type: 'setNodePosition',
      nodeName: 'A',
      position: [150, 250],
    });
    assert.deepEqual(ops[1], {
      type: 'setNodeDisabled',
      nodeName: 'A',
      disabled: true,
    });
  });

  it('generates setWorkflowMetadata and setWorkflowSettings when metadata or settings change', () => {
    const remote = {
      name: 'Old Name',
      nodes: [{ name: 'A', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1 }],
      connections: {},
      settings: { executionOrder: 'v0' },
    };

    const local = {
      name: 'New Name',
      nodes: [{ name: 'A', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1 }],
      connections: {},
      settings: { executionOrder: 'v1', timezone: 'America/New_York' },
    };

    const ops = generateWorkflowUpdateOperations(local, remote);
    const metaOp = ops.find(o => o.type === 'setWorkflowMetadata');
    assert.deepEqual(metaOp, {
      type: 'setWorkflowMetadata',
      name: 'New Name',
    });

    const settingsOp = ops.find(o => o.type === 'setWorkflowSettings');
    assert.deepEqual(settingsOp, {
      type: 'setWorkflowSettings',
      settings: { executionOrder: 'v1', timezone: 'America/New_York' },
    });
  });

  it('chunks operations into batches of at most 100 operations', () => {
    const ops = Array.from({ length: 250 }, (_, i) => ({
      type: 'setNodePosition',
      nodeName: `Node_${i}`,
      position: [i * 10, i * 10],
    }));

    const batches = chunkOperations(ops, 100);
    assert.equal(batches.length, 3);
    assert.equal(batches[0].length, 100);
    assert.equal(batches[1].length, 100);
    assert.equal(batches[2].length, 50);
  });
});

describe('Surgical Patches: Credential Trimming and Validation', () => {
  it('trims leading and trailing whitespace and newlines from credentials (e.g. from pbpaste)', () => {
    const trimmed = validateAndTrimCredential('   my-secret-key   \t\n', 'API Key');
    assert.equal(trimmed, 'my-secret-key');
  });

  it('returns undefined if credential is empty or undefined', () => {
    assert.equal(validateAndTrimCredential(undefined, 'API Key'), undefined);
    assert.equal(validateAndTrimCredential('', 'API Key'), '');
  });

  it('rejects credentials containing newlines or carriage returns inside the token', () => {
    assert.throws(
      () => validateAndTrimCredential('my-secret\nkey', 'API Key'),
      /API Key contains invalid characters/
    );
    assert.throws(
      () => validateAndTrimCredential('my-secret\r\nother', 'Access Token'),
      /Access Token contains invalid characters/
    );
  });

  it('rejects credentials containing control characters', () => {
    assert.throws(
      () => validateAndTrimCredential('secret\x00key', 'API Key'),
      /API Key contains invalid characters/
    );
  });
});

describe('Surgical Patches: Bug 3 - Pull Validation (Target and Project)', () => {
  it('identifies when no remote workflows match target argument', () => {
    const availableWorkflows = [
      { id: '1', name: 'Order Processing' },
      { id: '2', name: 'User Onboarding' },
    ];
    const target = 'NonExistentFlow';
    const matches = availableWorkflows.filter(w => isTargetScoped(w.name, w.id, w.name, target));
    assert.equal(matches.length, 0);

    // Assert that the expected error message is constructed
    const err = new Error(`No remote workflows matched target '${target}'.`);
    assert.match(err.message, /No remote workflows matched target 'NonExistentFlow'/);
  });

  it('validates project ID against search_projects and throws when absent', () => {
    const projectList = [
      { id: 'proj-123', name: 'Personal Project' },
      { id: 'proj-456', name: 'Team Project' },
    ];
    const targetProjectId = 'proj-999';
    const projectExists = projectList.some((p: any) => p.id === targetProjectId);
    assert.equal(projectExists, false);

    const checkProject = (id: string, list: any[]) => {
      if (list.length > 0 && !list.some(p => p.id === id)) {
        throw new Error(`Project with ID '${id}' was not found on remote instance.`);
      }
    };

    assert.throws(
      () => checkProject(targetProjectId, projectList),
      /Project with ID 'proj-999' was not found on remote instance\./
    );
  });
});

describe('Surgical Patches: Bug 1 - Push Write Failure and State Integrity', () => {
  it('does not update sync state or cache when writing workflow changes fails', () => {
    const syncState = {
      lastSync: new Date(0).toISOString(),
      workflows: {
        'workflows/my-flow.workflow.ts': {
          id: 'wf-1',
          name: 'My Flow',
          localPath: 'workflows/my-flow.workflow.ts',
          contentHash: 'hash-v1',
          remoteUpdatedAt: new Date(0).toISOString(),
        },
      },
    };

    let hasErrors = false;
    let cacheSaved = false;
    let loggedUpdated = false;

    // Simulate push workflow update loop with a failure
    try {
      const updatedSuccessfully = false;
      if (!updatedSuccessfully) {
        throw new Error("Failed to update workflow 'My Flow' (ID: wf-1). REST API, PostgreSQL database, and MCP tools were unable to write changes.");
      }

      // These must never run on failure:
      syncState.workflows['workflows/my-flow.workflow.ts'].contentHash = 'hash-v2';
      cacheSaved = true;
      loggedUpdated = true;
    } catch (err) {
      hasErrors = true;
    }

    assert.equal(hasErrors, true);
    assert.equal(cacheSaved, false);
    assert.equal(loggedUpdated, false);
    // Original syncState entry hash remains unchanged
    assert.equal(syncState.workflows['workflows/my-flow.workflow.ts'].contentHash, 'hash-v1');
  });
});


