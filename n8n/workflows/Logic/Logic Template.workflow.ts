const start_Trigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: {
    name: 'Start Trigger',
    position: [0, 150],
    notesInFlow: true,
    notes: 'Entry point to manually execute the logic workflow. In production, this can be triggered by a webhook or cron schedule.'
  }
});

const input_Data = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Input Data',
    parameters: {
      assignments: {
        assignments: [
          {
            id: 'set-items',
            name: 'items',
            value: [
              { id: 1, category: 'A', value: 150 },
              { id: 2, category: 'B', value: 50 },
              { id: 3, category: 'A', value: 75 },
              { id: 4, category: 'B', value: 120 }
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
    notes: 'Mocks input data as an array of objects, each containing an identifier, a category label, and a numeric value.'
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
    notes: 'Splits the input array into individual n8n items, creating an active stream for each object.'
  }
});

const filter_Value = node({
  type: 'n8n-nodes-base.if',
  version: 2.3,
  config: {
    name: 'Filter Value',
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict'
        },
        conditions: [
          {
            id: 'value-check',
            leftValue: '={{ $json.value }}',
            rightValue: 100,
            operator: {
              type: 'number',
              operation: 'gt'
            }
          }
        ],
        combinator: 'and'
      },
      options: {}
    },
    position: [560, 150],
    notesInFlow: true,
    notes: 'Conditional filter: routes items based on value. Items exceeding 100 go to output 0 (True), others go to output 1 (False).'
  }
});

const high_Value_Status = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'High Value Status',
    parameters: {
      assignments: {
        assignments: [
          {
            id: 'set-status-high',
            name: 'status',
            value: 'high',
            type: 'string'
          }
        ]
      },
      includeOtherFields: true,
      options: {}
    },
    position: [800, 50],
    notesInFlow: true,
    notes: "Processes high-value items, tagging them with status 'high'."
  }
});

const switch_Category = node({
  type: 'n8n-nodes-base.switch',
  version: 3.4,
  config: {
    name: 'Switch Category',
    parameters: {
      rules: {
        values: [
          {
            conditions: {
              options: {
                caseSensitive: true,
                leftValue: '',
                typeValidation: 'strict'
              },
              conditions: [
                {
                  leftValue: '={{ $json.category }}',
                  rightValue: 'A',
                  operator: {
                    type: 'string',
                    operation: 'equals'
                  }
                }
              ],
              combinator: 'and'
            }
          },
          {
            conditions: {
              options: {
                caseSensitive: true,
                leftValue: '',
                typeValidation: 'strict'
              },
              conditions: [
                {
                  leftValue: '={{ $json.category }}',
                  rightValue: 'B',
                  operator: {
                    type: 'string',
                    operation: 'equals'
                  }
                }
              ],
              combinator: 'and'
            }
          }
        ]
      },
      options: {}
    },
    position: [800, 250],
    notesInFlow: true,
    notes: 'Category-based router for low-value items. Splits execution path into multiple channels based on string equality matches.'
  }
});

const set_Category_A_Status = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Set Category A Status',
    parameters: {
      assignments: {
        assignments: [
          {
            id: 'set-status-low-a',
            name: 'status',
            value: 'low_a',
            type: 'string'
          }
        ]
      },
      includeOtherFields: true,
      options: {}
    },
    position: [1020, 200],
    notesInFlow: true,
    notes: "Applies 'low_a' status to low-value items belonging to Category A."
  }
});

const set_Category_B_Status = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Set Category B Status',
    parameters: {
      assignments: {
        assignments: [
          {
            id: 'set-status-low-b',
            name: 'status',
            value: 'low_b',
            type: 'string'
          }
        ]
      },
      includeOtherFields: true,
      options: {}
    },
    position: [1020, 320],
    notesInFlow: true,
    notes: "Applies 'low_b' status to low-value items belonging to Category B."
  }
});

const merge_Low_Value = node({
  type: 'n8n-nodes-base.merge',
  version: 3.2,
  config: {
    name: 'Merge Low Value',
    parameters: {
      mode: 'append',
      options: {}
    },
    position: [1240, 250],
    notesInFlow: true,
    notes: 'Merges the low-value branches (Category A and Category B handlers) back into a single low-value stream.'
  }
});

const merge_Results = node({
  type: 'n8n-nodes-base.merge',
  version: 3.2,
  config: {
    name: 'Merge Results',
    parameters: {
      mode: 'append',
      options: {}
    },
    position: [1440, 150],
    notesInFlow: true,
    notes: 'Re-converges high-value and low-value processing branches into a single consolidated output stream.'
  }
});

const aggregate_Items = node({
  type: 'n8n-nodes-base.aggregate',
  version: 1,
  config: {
    name: 'Aggregate Items',
    parameters: {
      fieldsToAggregate: {
        fieldToAggregate: [
          {
            fieldToAggregate: 'status',
            renameField: true,
            outputFieldName: 'statuses'
          }
        ]
      },
      options: {}
    },
    position: [1640, 150],
    notesInFlow: true,
    notes: 'Aggregates the individual processed items back into a single array summary of all statuses.'
  }
});

const wf = workflow('logic-template', 'Logic Template', {
  executionOrder: 'v1',
  availableInMCP: true,
  binaryMode: 'separate',
  description: 'Standard logic pattern using If, Switch, Merge, Split, and Aggregate.'
});

// Register all nodes with workflow builder
wf.add(start_Trigger);
wf.add(input_Data);
wf.add(split_Items);
wf.add(filter_Value);
wf.add(high_Value_Status);
wf.add(switch_Category);
wf.add(set_Category_A_Status);
wf.add(set_Category_B_Status);
wf.add(merge_Low_Value);
wf.add(merge_Results);
wf.add(aggregate_Items);

// Sequential connections
start_Trigger.to(input_Data);
input_Data.to(split_Items);
split_Items.to(filter_Value);

// If Node: output 0 is True, output 1 is False
filter_Value.to(high_Value_Status); // output 0
filter_Value.output(1).to(switch_Category); // output 1

// Switch Node: output 0 is Category A, output 1 is Category B
switch_Category.to(set_Category_A_Status); // output 0
switch_Category.output(1).to(set_Category_B_Status); // output 1

// Merge Low Value inputs
set_Category_A_Status.to(merge_Low_Value.input(0));
set_Category_B_Status.to(merge_Low_Value.input(1));

// Merge Results inputs
high_Value_Status.to(merge_Results.input(0));
merge_Low_Value.to(merge_Results.input(1));

merge_Results.to(aggregate_Items);

export default wf;
