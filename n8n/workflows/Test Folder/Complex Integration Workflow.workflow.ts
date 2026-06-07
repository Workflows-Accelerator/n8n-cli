const start = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Start', position: [100, 200] }
});

const get_Users = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: { name: 'Get Users', parameters: { url: 'https://jsonplaceholder.typicode.com/users', method: 'GET', options: {} }, position: [300, 200] }
});

const check_Email_Domain = node({
  type: 'n8n-nodes-base.if',
  version: 2.3,
  config: { name: 'Check Email Domain', parameters: { conditions: { options: { caseSensitive: false, leftValue: '', typeValidation: 'strict' }, combinator: 'and', conditions: [{ leftValue: expr('{{ $json.email }}'), operator: { type: 'string', operation: 'contains' }, rightValue: '.biz' }] } }, position: [500, 200] }
});

const format_Data = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Format Data', parameters: { jsCode: 'for (const item of $input.all()) {\n  item.json.formattedName = item.json.name.toUpperCase();\n}\nreturn $input.all();' }, position: [700, 100] }
});

const finalize_Results = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'Finalize Results', parameters: { fields: { values: [{ name: 'status', value: 'processed' }, { name: 'name', value: expr('{{ $json.formattedName }}') }] } }, position: [900, 100] }
});

const log_Skipped = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'Log Skipped', parameters: { fields: { values: [{ name: 'status', value: 'skipped' }] } }, position: [700, 300] }
});

const wf = workflow('PcM4m4OFHiPDP2bB', 'Complex Integration Workflow', { executionOrder: 'v1', binaryMode: 'separate', availableInMCP: true });

export default wf
  .add(start)
  .to(get_Users)
  .to(check_Email_Domain.onTrue(format_Data
    .to(finalize_Results)).onFalse(log_Skipped))