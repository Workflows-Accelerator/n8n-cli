const when_clicking_Execute_workflow = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'When clicking \u2018Execute workflow\u2019' }
});

const wf = workflow('OEkeeChNKGU86bJp', 'Test workflow', { executionOrder: 'v1', binaryMode: 'separate', availableInMCP: true, callerPolicy: 'workflowsFromSameOwner' });

export default wf
  .add(when_clicking_Execute_workflow)