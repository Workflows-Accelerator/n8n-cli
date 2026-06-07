const schedule_Trigger = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: { name: 'Schedule Trigger', parameters: { rule: { interval: [{}] } }, position: [100, 300] }
});

const wf = workflow('cczgeo4inKplHEST', 'Workflow at Root of Target Folder', { executionOrder: 'v1', binaryMode: 'separate', availableInMCP: true, callerPolicy: 'workflowsFromSameOwner' });

export default wf
  .add(schedule_Trigger)