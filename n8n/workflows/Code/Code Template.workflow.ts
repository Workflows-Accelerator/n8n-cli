const start_Trigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: {
    name: 'Start Trigger',
    position: [0, 150],
    notesInFlow: true,
    notes: 'Starts the code execution template workflow manually for testing.'
  }
});

const mock_Input = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Mock Input',
    parameters: {
      assignments: {
        assignments: [
          {
            id: 'set-items',
            name: 'items',
            value: [
              { id: 1, value: 10 },
              { id: 2, value: 20 },
              { id: 3, value: 30 }
            ],
            type: 'array'
          }
        ]
      },
      includeOtherFields: false,
      options: {}
    },
    position: [180, 150],
    notesInFlow: true,
    notes: 'Mocks input data containing an array of simple items for traversal.'
  }
});

const split_Items = node({
  type: 'n8n-nodes-base.splitOut',
  version: 1,
  config: {
    name: 'Split Items',
    parameters: {
      fieldToSplitOut: 'items',
      options: {}
    },
    position: [360, 150],
    notesInFlow: true,
    notes: 'Splits out the input items array into individual execution streams.'
  }
});

const run_Once_For_Each = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Run Once For Each',
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode: 'return { json: { processed: $json.value * 2 } };'
    },
    position: [560, 150],
    notesInFlow: true,
    notes: 'Run Once For Each Item mode: executes the code loop once per incoming item, modifying the data dynamically.'
  }
});

const run_Once_For_All = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Run Once For All',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: 'const items = $input.all();\nconst sum = items.reduce((acc, item) => acc + item.json.processed, 0);\nreturn [{ json: { totalSum: sum } }];'
    },
    position: [760, 150],
    notesInFlow: true,
    notes: 'Run Once For All Items mode: executes exactly once for the entire batch, performing aggregation operations.'
  }
});

const wf = workflow('code-template', 'Code Template', {
  executionOrder: 'v1',
  availableInMCP: true,
  binaryMode: 'separate',
  description: 'Standard code template demonstrating executing once for each item and once for all items.'
});

// Add all nodes to workflow builder
wf.add(start_Trigger);
wf.add(mock_Input);
wf.add(split_Items);
wf.add(run_Once_For_Each);
wf.add(run_Once_For_All);

// Sequential connections
start_Trigger.to(mock_Input);
mock_Input.to(split_Items);
split_Items.to(run_Once_For_Each);
run_Once_For_Each.to(run_Once_For_All);

export default wf;
