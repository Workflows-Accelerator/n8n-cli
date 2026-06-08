const google_Gemini_Model = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini',
  version: 1,
  config: {
    name: 'Google Gemini Model',
    parameters: {
      modelName: 'models/gemini-3.1-flash-lite-preview',
      options: {
        temperature: 0.2,
        topP: 0.9
      }
    },
    credentials: {
      googlePalmApi: newCredential('Google Gemini API Key', 'QWpzmztRGaBDrcyt')
    },
    position: [200, 150],
    notesInFlow: true,
    notes: 'Chat model node configured to connect with the Google Gemini API. The low temperature (0.2) is selected to minimize hallucinations and enforce consistent, deterministic summarization outputs.'
  }
});

const start_Trigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: {
    name: 'Start Trigger',
    position: [0, 0],
    notesInFlow: true,
    notes: 'Manual testing trigger to invoke the AI workflow. In production, this can be swapped with a schedule or webhook trigger to process new items automatically.'
  }
});

const generate_Response = node({
  type: '@n8n/n8n-nodes-langchain.chainLlm',
  version: 1.9,
  config: {
    name: 'Generate Response',
    parameters: {
      promptType: 'define',
      text: expr(
        '=# Instructions\n' +
        '<instructions>\n' +
        '<goal>\n' +
        'Summarize the input text into three concise bullet points.\n' +
        '</goal>\n\n' +
        '<context>\n' +
        'You are a professional summarization assistant. The text provided is any general content.\n' +
        '</context>\n\n' +
        '<rules>\n' +
        '1. Keep bullet points professional and objective.\n' +
        '2. Enforce spelling and grammar checks in English.\n' +
        '</rules>\n\n' +
        '<output_format>\n' +
        '- Markdown bulleted list.\n' +
        '- Plain text only, no conversational intro or outro.\n' +
        '</output_format>\n' +
        '</instructions>\n\n' +
        '# Inputs\n' +
        '<inputs>\n' +
        '<text>{{ $json.text }}</text>\n' +
        '</inputs>'
      ),
      messages: {
        messageValues: [
          { message: 'You are a professional assistant specialized in summarizing text.' }
        ]
      }
    },
    position: [200, 0],
    subnodes: {
      model: google_Gemini_Model
    },
    notesInFlow: true,
    notes: 'LangChain LLM Chain executing the structured XML prompt format. This prompt separates instructions (goals, context, rules, output format) from inputs, ensuring the model adheres to constraints.'
  }
});

const wf = workflow('ai-prompt-template', 'AI Prompt Template', {
  executionOrder: 'v1',
  availableInMCP: true,
  binaryMode: 'separate',
  description: 'Standard template for structured prompts using language model chains.'
});

export default wf
  .add(start_Trigger)
  .to(generate_Response);
