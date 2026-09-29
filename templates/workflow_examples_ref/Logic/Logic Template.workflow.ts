const start_Trigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Start Trigger', position: [0, 220], notes: 'Entry point to manually execute the logic workflow. In production, this can be triggered by a webhook or cron schedule.', notesInFlow: true }
});

const format_Date = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'Format Date', parameters: { assignments: { assignments: [{ id: 'set-date', name: 'dateString', value: expr('{{ new Date().toISOString() }}'), type: 'string' }] }, includeOtherFields: true, options: {} }, position: [220, 220], notes: 'Formats current execution date.', notesInFlow: true }
});

const input_Data = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'Input Data', parameters: { assignments: { assignments: [{ id: 'set-items', name: 'items', value: [{ id: 1, category: 'A', value: 150 }, { id: 2, category: 'B', value: 50 }, { id: 3, category: 'A', value: 75 }, { id: 4, category: 'B', value: 120 }], type: 'array' }] }, options: {} }, position: [440, 220], notes: 'Mocks input data as an array of objects, each containing an identifier, a category label, and a numeric value.', notesInFlow: true }
});

const split_Items = node({
  type: 'n8n-nodes-base.splitOut',
  version: 1,
  config: { name: 'Split Items', parameters: { fieldToSplitOut: 'items', options: {} }, position: [640, 220], notes: 'Splits the input array into individual n8n items, creating an active stream for each object.', notesInFlow: true }
});

const calculate_Margin = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'Calculate Margin', parameters: { assignments: { assignments: [{ id: 'set-margin', name: 'margin', value: expr('{{ $json.value * 0.2 }}'), type: 'number' }] }, includeOtherFields: true, options: {} }, position: [860, 220], notes: 'Calculates a 20% profit margin for each split item.', notesInFlow: true }
});

const margin_Check = node({
  type: 'n8n-nodes-base.if',
  version: 2.3,
  config: { name: 'Margin Check', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 }, conditions: [{ id: 'margin-high-check', leftValue: expr('{{ $json.margin }}'), rightValue: 20, operator: { type: 'number', operation: 'gt' } }], combinator: 'and' }, options: {} }, position: [1080, 220], notes: 'Checks if calculated margin is significant.', notesInFlow: true }
});

const filter_Value = node({
  type: 'n8n-nodes-base.if',
  version: 2.3,
  config: { name: 'Filter Value', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 }, conditions: [{ id: 'value-check', leftValue: expr('{{ $json.value }}'), rightValue: 100, operator: { type: 'number', operation: 'gt' } }], combinator: 'and' }, options: {} }, position: [1300, 140], notes: 'Conditional filter: routes items based on value. Items exceeding 100 go to output 0 (True), others go to output 1 (False).', notesInFlow: true }
});

const high_Value_Status = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'High Value Status', parameters: { assignments: { assignments: [{ id: 'set-status-high', name: 'status', value: 'high', type: 'string' }] }, includeOtherFields: true, options: {} }, position: [1940, 40], notes: 'Processes high-value items, tagging them with status \'high\'.', notesInFlow: true }
});

const log_High_Margin = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Log High Margin', parameters: { jsCode: 'return $input.all().map(item => ({ json: { ...item.json, logMessage: `HIGH MARGIN: Category ${item.json.category} value is ${item.json.value}` } }));' }, position: [2160, 40], notes: 'Logs details of high-value items.', notesInFlow: true }
});

const merge_Results = merge({
  version: 3.2,
  config: { name: 'Merge Results', parameters: { numberInputs: 3 }, position: [2380, 184], notes: 'Re-converges high-value and low-value processing branches into a single consolidated output stream.', notesInFlow: true }
});

const switch_Category = node({
  type: 'n8n-nodes-base.switch',
  version: 3.4,
  config: { name: 'Switch Category', parameters: { rules: { values: [{ conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 }, conditions: [{ leftValue: expr('{{ $json.category }}'), rightValue: 'A', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' } }, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 }, conditions: [{ leftValue: expr('{{ $json.category }}'), rightValue: 'B', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' } }, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 }, conditions: [{ leftValue: expr('{{ $json.category }}'), rightValue: 'C', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' } }] }, options: {} }, position: [1520, 224], notes: 'Category-based router for low-value items. Splits execution path into multiple channels based on string equality matches.', notesInFlow: true }
});

const set_Category_a_Status = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'Set Category a Status', parameters: { assignments: { assignments: [{ id: 'set-status-low-a', name: 'status', value: 'low_a', type: 'string' }] }, includeOtherFields: true, options: {} }, position: [1720, 60], notes: 'Applies \'low_a\' status to low-value items belonging to Category A.', notesInFlow: true }
});

const merge_Low_Value = merge({
  version: 3.2,
  config: { name: 'Merge Low Value', parameters: { numberInputs: 3 }, position: [1940, 224], notes: 'Merges the low-value branches (Category A, Category B and Category C handlers) back into a single low-value stream.', notesInFlow: true }
});

const set_Category_B_Status = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'Set Category B Status', parameters: { assignments: { assignments: [{ id: 'set-status-low-b', name: 'status', value: 'low_b', type: 'string' }] }, includeOtherFields: true, options: {} }, position: [1720, 240], notes: 'Applies \'low_b\' status to low-value items belonging to Category B.', notesInFlow: true }
});

const set_Category_C_Status = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'Set Category C Status', parameters: { assignments: { assignments: [{ id: 'set-status-low-c', name: 'status', value: 'low_c', type: 'string' }] }, includeOtherFields: true, options: {} }, position: [1720, 400], notes: 'Applies \'low_c\' status to low-value items belonging to Category C.', notesInFlow: true }
});

const margin_Alert = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'Margin Alert', parameters: { assignments: { assignments: [{ id: 'set-alert-status', name: 'status', value: 'low_margin_alert', type: 'string' }] }, includeOtherFields: true, options: {} }, position: [2160, 320], notes: 'Applies alert status for low margin items.', notesInFlow: true }
});

const calculate_Total_Margin = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'Calculate Total Margin', parameters: { assignments: { assignments: [{ id: 'set-total-margin', name: 'totalMargin', value: expr('{{ $json.margin * 1.15 }}'), type: 'number' }] }, includeOtherFields: true, options: {} }, position: [2600, 200], notes: 'Calculates the total margin with a markup factor.', notesInFlow: true }
});

const sort_Results = node({
  type: 'n8n-nodes-base.sort',
  version: 1,
  config: { name: 'Sort Results', parameters: { sortFieldsUi: { sortField: [{ fieldName: 'totalMargin', direction: 'descending' }] }, options: {} }, position: [2800, 200], notes: 'Sorts items by total margin in descending order.', notesInFlow: true }
});

const aggregate_Items = node({
  type: 'n8n-nodes-base.aggregate',
  version: 1,
  config: { name: 'Aggregate Items', parameters: { fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: 'status', renameField: true, outputFieldName: 'statuses' }] }, options: {} }, position: [3020, 200], notes: 'Aggregates the individual processed items back into a single array summary of all statuses.', notesInFlow: true }
});

const log_Low_Margin = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Log Low Margin', parameters: { jsCode: 'return $input.all().map(item => ({ json: { ...item.json, logMessage: `Category ${item.json.category} has value ${item.json.value} and margin ${item.json.margin}` } }));' }, position: [2160, 240], notes: 'Generates a custom diagnostic log message for each low-value item.', notesInFlow: true }
});

const wf = workflow('cGRwNKiu41Tf5XaC', 'Logic Template', { binaryMode: 'separate', description: 'Standard logic pattern using If, Switch, Merge, Split, and Aggregate.', availableInMCP: true, executionOrder: 'v1' });

export default wf
  .add(start_Trigger)
  .to(format_Date)
  .to(input_Data)
  .to(split_Items)
  .to(calculate_Margin)
  .to(margin_Check.onTrue(filter_Value.onTrue(high_Value_Status
      .to(log_High_Margin)).onFalse(switch_Category.onCase(0, set_Category_a_Status).onCase(1, set_Category_B_Status).onCase(2, set_Category_C_Status))).onFalse(margin_Alert))
  .add(log_High_Margin.to(merge_Results.input(0)))
  .add(set_Category_a_Status.to(merge_Low_Value.input(0)))
  .add(set_Category_B_Status.to(merge_Low_Value.input(1)))
  .add(set_Category_C_Status.to(merge_Low_Value.input(2)))
  .add(margin_Alert.to(merge_Results.input(2)))
  .add(log_Low_Margin.to(merge_Results.input(1)))
  .add(merge_Results)
  .to(calculate_Total_Margin
  .to(sort_Results)
  .to(aggregate_Items))
  .add(merge_Low_Value)
  .to(log_Low_Margin)
