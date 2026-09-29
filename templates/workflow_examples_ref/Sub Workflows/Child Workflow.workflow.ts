const execute_Workflow_Trigger = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.1,
  config: { name: 'Execute Workflow Trigger', parameters: { workflowInputs: { values: [{ name: 'itemId' }, { name: 'status' }] } }, position: [100, 0], notes: 'The entry point trigger for sub-workflows called by a parent. It declares input variables (itemId, status) so calling workflows know what payload to supply.', notesInFlow: true }
});

const set_Output_Data = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'Set Output Data', parameters: { assignments: { assignments: [{ id: 'set-item-id', name: 'itemId', value: expr('{{ $json.itemId }}'), type: 'string' }, { id: 'set-processed-status', name: 'status', value: 'processed', type: 'string' }] }, includeOtherFields: false, options: {} }, position: [320, 0], notes: 'Sets the output properties for the sub-workflow. It passes back the itemId and updates the status to \'processed\'. The final result is returned to the parent workflow.', notesInFlow: true }
});

const wf = workflow('97xALgC78R8LYWdN', 'Child Workflow', { binaryMode: 'separate', description: 'Child workflow template designed to be executed by a parent workflow.', availableInMCP: true, executionOrder: 'v1' });

export default wf
  .add(execute_Workflow_Trigger)
  .to(set_Output_Data)
