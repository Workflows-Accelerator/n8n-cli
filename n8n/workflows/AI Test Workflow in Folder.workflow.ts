const openAiModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  version: 1.3,
  config: {
    name: 'OpenAI Model',
    parameters: {
      model: 'gpt-4o-mini',
      temperature: 0.7
    },
    credentials: { openAiApi: newCredential('OpenAI') },
    position: [540, 500]
  }
});

const calculatorTool = tool({
  type: '@n8n/n8n-nodes-langchain.toolCalculator',
  version: 1,
  config: {
    name: 'Calculator Tool',
    position: [700, 500]
  }
});

const startTrigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Start Trigger', position: [240, 300] }
});

const aiAgent = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 3.1,
  config: {
    name: 'AI Agent',
    parameters: {
      promptType: 'define',
      text: expr('Compute the following mathematical expression: {{ $json.expression }}'),
      options: {
        systemMessage: 'You are a helpful assistant. Use the Calculator Tool if you need to compute mathematical expressions.'
      }
    },
    subnodes: {
      model: openAiModel,
      tools: [calculatorTool]
    },
    position: [540, 300]
  },
  output: [{ output: 'The result of 2 + 2 is 4.' }]
});

const wf = workflow('yY6V4ckA4Re4AKSz', 'AI Test Workflow in Folder', {
  description: 'AI Agent workflow that utilizes a language model and a calculator tool to answer mathematical questions.',
  executionOrder: 'v1',
  availableInMCP: true
});

export default wf
  .add(startTrigger)
  .to(aiAgent)
  .add(sticky('## AI Agent Standard\nThis workflow demonstrates a standard pattern for setting up an AI Agent with tools in n8n.\n\n— Workflows Accelerator —', [], { name: 'Documentation Note', height: 200, position: [-48, -192] }));