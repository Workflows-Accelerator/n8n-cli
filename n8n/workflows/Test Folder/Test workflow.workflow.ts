const when_Clicking_Execute_Workflow = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'When Clicking Execute Workflow', position: [100, 300] }
});

const set_Data = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'Set Data', parameters: { fields: { values: [{ name: 'test', value: expr('{{ $("When Clicking Execute Workflow").item.json.myVar }}') }] } }, position: [300, 300] }
});

const wf = workflow('OEkeeChNKGU86bJp', 'Test Workflow', { executionOrder: 'v1', binaryMode: 'separate', availableInMCP: true, callerPolicy: 'workflowsFromSameOwner' });

export default wf
  .add(when_Clicking_Execute_Workflow)
  .to(set_Data)