const google_Gemini_Model = languageModel({ type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', version: 1, config: { name: 'Google Gemini Model', parameters: { modelName: expr('models/gemini-flash-lite-latest'), options: { temperature: 0, topP: 0.9 } }, credentials: { googlePalmApi: newCredential('FRG RutgerParris@gmail.com', 'QWpzmztRGaBDrcyt') }, position: [544, 512] } });
const calculator_Tool = tool({ type: '@n8n/n8n-nodes-langchain.toolCalculator', version: 1, config: { name: 'Calculator Tool', position: [704, 512] } });

const start_Trigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Start Trigger', position: [240, 304] }
});

const aI_Agent = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 3.1,
  config: { name: 'AI Agent', parameters: { promptType: 'define', text: expr('Compute the following mathematical expression: {{ $json.expression }}'), options: { systemMessage: 'You are a helpful assistant. Use the Calculator Tool if you need to compute mathematical expressions.' } }, position: [544, 304], subnodes: { model: google_Gemini_Model, tools: [calculator_Tool] } }
});

const wf = workflow('yY6V4ckA4Re4AKSz', 'AI Test Workflow in Folder', { description: 'AI Agent workflow that utilizes a language model and a calculator tool to answer mathematical questions.', executionOrder: 'v1', availableInMCP: true, binaryMode: 'separate' });

export default wf
  .add(start_Trigger)
  .to(aI_Agent)
  .add(sticky('## AI Agent Standard\nThis workflow demonstrates a standard pattern for setting up an AI Agent with Google Gemini in n8n.\n\n— Workflows Accelerator —', [], { name: 'Documentation Note', height: 200, position: [-48, -192] }))