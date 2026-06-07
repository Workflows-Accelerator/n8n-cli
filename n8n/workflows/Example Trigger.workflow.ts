const when_Clicking_Execute_Workflow = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'When Clicking Execute Workflow', position: [100, 300] }
});

const wf = workflow('KJHvf5E2uuo9Zfam', 'Example Trigger', { description: 'An example manual trigger workflow.', executionOrder: 'v1', binaryMode: 'separate', availableInMCP: true, callerPolicy: 'workflowsFromSameOwner' });

export default wf
  .add(when_Clicking_Execute_Workflow)
  .add(sticky('## This is an example note\nPlease use those in your workflows and add this at the end of notes :\n\n— Workflows Accelerator —', [], { name: 'Sticky Note', height: 256, position: [-48, -192] }))