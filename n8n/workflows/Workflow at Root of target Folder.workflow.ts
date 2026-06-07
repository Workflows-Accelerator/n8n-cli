const schedule_Trigger = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: { name: 'Schedule Trigger', parameters: { rule: { interval: [{}] } } }
});

const wf = workflow('cczgeo4inKplHEST', 'Workflow at Root of target Folder', { executionOrder: 'v1', binaryMode: 'separate', availableInMCP: true });

export default wf
  .add(schedule_Trigger)