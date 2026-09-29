const start_Trigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Start Trigger', position: [0, 160], notes: 'Starts the code execution template workflow manually for testing.', notesInFlow: true }
});

const mock_Input = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'Mock Input', parameters: { assignments: { assignments: [{ id: 'set-items', name: 'items', value: [{ id: 1, value: 10 }, { id: 2, value: 20 }, { id: 3, value: 30 }], type: 'array' }] }, options: {} }, position: [220, 160], notes: 'Mocks input data containing an array of simple items for traversal.', notesInFlow: true }
});

const split_Items = node({
  type: 'n8n-nodes-base.splitOut',
  version: 1,
  config: { name: 'Split Items', parameters: { fieldToSplitOut: 'items', options: {} }, position: [440, 160], notes: 'Splits out the input items array into individual execution streams.', notesInFlow: true }
});

const run_Once_For_Each = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Run Once For Each', parameters: { mode: 'runOnceForEachItem', jsCode: 'return { json: { processed: $json.value * 2 } };' }, position: [640, 160], notes: 'Run Once For Each Item mode: executes the code loop once per incoming item, modifying the data dynamically.', notesInFlow: true }
});

const run_Once_For_All = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Run Once For All', parameters: { jsCode: 'const items = $input.all();\nconst sum = items.reduce((acc, item) => acc + item.json.processed, 0);\nreturn [{ json: { totalSum: sum } }];' }, position: [860, 160], notes: 'Run Once For All Items mode: executes exactly once for the entire batch, performing aggregation operations.', notesInFlow: true }
});

const wf = workflow('tK55D0eyhgRZLMnt', 'Code Template', { binaryMode: 'separate', description: 'Standard code template demonstrating executing once for each item and once for all items.', availableInMCP: true, executionOrder: 'v1' });

export default wf
  .add(start_Trigger)
  .to(mock_Input)
  .to(split_Items)
  .to(run_Once_For_Each)
  .to(run_Once_For_All)
