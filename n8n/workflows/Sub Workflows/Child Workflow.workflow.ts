const execute_Workflow_Trigger = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.1,
  config: {
    name: 'Execute Workflow Trigger',
    parameters: {
      workflowInputs: {
        values: [
          { name: 'itemId' },
          { name: 'status' }
        ]
      }
    },
    position: [0, 0],
    notesInFlow: true,
    notes: 'The entry point trigger for sub-workflows called by a parent. It declares input variables (itemId, status) so calling workflows know what payload to supply.'
  }
});

const set_Output_Data = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Set Output Data',
    parameters: {
      assignments: {
        assignments: [
          {
            id: 'set-item-id',
            name: 'itemId',
            value: expr('{{ $json.itemId }}'),
            type: 'string'
          },
          {
            id: 'set-processed-status',
            name: 'status',
            value: 'processed',
            type: 'string'
          }
        ]
      },
      includeOtherFields: false,
      options: {}
    },
    position: [200, 0],
    notesInFlow: true,
    notes: "Sets the output properties for the sub-workflow. It passes back the itemId and updates the status to 'processed'. The final result is returned to the parent workflow."
  }
});

const wf = workflow('child-workflow-template', 'Child Workflow', {
  executionOrder: 'v1',
  availableInMCP: true,
  binaryMode: 'separate',
  description: 'Child workflow template designed to be executed by a parent workflow.'
});

export default wf
  .add(execute_Workflow_Trigger)
  .to(set_Output_Data);
