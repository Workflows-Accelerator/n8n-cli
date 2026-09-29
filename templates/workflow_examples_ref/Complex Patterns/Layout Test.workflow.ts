const openAI_Chat_Model = languageModel({ type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', version: 1.2, config: { name: 'OpenAI Chat Model', parameters: { model: { __rl: true, mode: 'list', value: 'gpt-5-mini' }, options: {} }, position: [720, 300], notes: 'Provides LLM intelligence.', notesInFlow: true } });
const agent_Memory = memory({ type: '@n8n/n8n-nodes-langchain.memoryBufferWindow', version: 1.3, config: { name: 'Agent Memory', position: [880, 300], notes: 'Keeps track of conversations.', notesInFlow: true } });
const calculator_Tool = tool({ type: '@n8n/n8n-nodes-langchain.toolCalculator', version: 1, config: { name: 'Calculator Tool', position: [1040, 300], notes: 'Performs calculations.', notesInFlow: true } });
const slack_Approval = tool({ type: 'n8n-nodes-base.slackHitlTool', version: 2.5, config: { name: 'Slack Approval', parameters: { user: { __rl: true, mode: 'list', value: '' }, options: {} }, position: [1200, 300], webhookId: '1737ca71-89c4-4745-a3e6-1c75a0d02180', notes: 'Slack human-in-the-loop sub-cluster tool.', notesInFlow: true } });

const start_Trigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Start Trigger', position: [100, 40], notes: 'Triggers the complex testing workflow.', notesInFlow: true }
});

const merge_Node = merge({
  version: 3.2,
  config: { name: 'Merge Node', parameters: { mode: 'combine', combineBy: 'combineByPosition', options: {} }, position: [540, 40], notes: 'Merges both streams A and B.', notesInFlow: true }
});

const fetch_A = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: { name: 'Fetch A', position: [320, -40], notes: 'Fetches parallel branch data A.', notesInFlow: true }
});

const fetch_B = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: { name: 'Fetch B', position: [320, 140], notes: 'Fetches parallel branch data B.', notesInFlow: true }
});

const check_Status = node({
  type: 'n8n-nodes-base.if',
  version: 2.3,
  config: { name: 'Check Status', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1, type: 'string' }, conditions: [{ id: 'cond-1', leftValue: expr('{{ $json.status }}'), rightValue: 'active', operator: 'equals', type: 'string' }], combinator: 'and' }, options: {} }, position: [740, 40], notes: 'Routes execution based on a status check.', notesInFlow: true }
});

const aI_Agent = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 1.7,
  config: { name: 'AI Agent', parameters: { options: {} }, position: [960, 40], notes: 'Coordinates AI task execution using model, memory, and tools.', notesInFlow: true, subnodes: { model: openAI_Chat_Model, memory: agent_Memory, tools: [calculator_Tool, slack_Approval] } }
});

const done_Log = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: { name: 'Done Log', position: [1360, 40], notes: 'Workflow end/logger.', notesInFlow: true }
});

const wf = workflow('hDa19V2W60xfm5Mn', 'Layout Test', { binaryMode: 'separate', description: 'A complex test workflow containing logic, merge, and AI agents with sub-nodes and sub-clusters.', availableInMCP: true, executionOrder: 'v1' });

export default wf
  .add(start_Trigger
  .to([
    fetch_A,
    fetch_B]))
  .add(fetch_A.to(merge_Node.input(0)))
  .add(fetch_B.to(merge_Node.input(1)))
  .add(merge_Node)
  .to(check_Status.onTrue(aI_Agent
    .to(done_Log)))
