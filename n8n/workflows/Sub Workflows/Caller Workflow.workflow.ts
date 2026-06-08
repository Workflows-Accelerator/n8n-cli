const start_Trigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: {
    name: 'Start Trigger',
    position: [0, 0],
    notesInFlow: true,
    notes: 'Entry point to manually run the caller workflow. In production, it can run on a schedule, via a webhook, or when triggered by another system.'
  }
});

const execute_Child_Workflow = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Execute Child Workflow',
    parameters: {
      workflowId: {
        __rl: true,
        value: 'child-workflow-template',
        mode: 'list',
        cachedResultName: 'Child Workflow'
      },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          itemId: expr('{{ $json.itemId }}'),
          status: 'pending'
        },
        schema: [
          { id: 'itemId', displayName: 'itemId', type: 'string' },
          { id: 'status', displayName: 'status', type: 'string' }
        ]
      }
    },
    position: [200, 0],
    executeOnce: true,
    notesInFlow: true,
    notes: 'Synchronously executes the child sub-workflow by ID. Passes itemId and status parameters using defineBelow parameter mapping. executeOnce is set to true to ensure it runs only once even if multiple items are passed.'
  }
});

const wf = workflow('caller-workflow-template', 'Caller Workflow', {
  executionOrder: 'v1',
  availableInMCP: true,
  binaryMode: 'separate',
  description: 'Caller workflow demonstrating how to execute sub workflows.'
});

export default wf
  .add(start_Trigger)
  .to(execute_Child_Workflow);
