const google_Gemini_Model = languageModel({ type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', version: 1, config: { name: 'Google Gemini Model', parameters: { modelName: 'models/gemini-3.1-flash-lite-preview', options: { temperature: 0.2, topP: 0.9 } }, credentials: { googlePalmApi: newCredential('Google Gemini API Key', 'QWpzmztRGaBDrcyt') }, position: [2260, 400], notes: 'Specifies the chat model to be used by the LLM chain. Setting a low temperature forces deterministic and factual generations.', notesInFlow: true } });

const start_Trigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Start Trigger', position: [0, 140], notes: 'Starts the complex orchestration manually. Can be replaced with a schedule, webhook, or queue listener in production.', notesInFlow: true }
});

const merge_Data_by_Position = merge({
  version: 3.2,
  config: { name: 'Merge Data by Position', parameters: { mode: 'combine', combineBy: 'combineByPosition', options: {} }, position: [440, 140], notes: 'Combines data from both branches (metadata context and primary stream items) by position, creating a single unified data context.', notesInFlow: true }
});

const fetch_Context_Metadata = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: { name: 'Fetch Context Metadata', position: [220, 60], notes: 'First branch: Fetches high-level schema settings, context values, or identifier mappings from an external system.', notesInFlow: true }
});

const fetch_Stream_Content = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: { name: 'Fetch Stream Content', position: [220, 240], notes: 'Second branch: Fetches the primary text content or stream items to be processed in parallel with the metadata context.', notesInFlow: true }
});

const split_Responses_Array = node({
  type: 'n8n-nodes-base.splitOut',
  version: 1,
  config: { name: 'Split Responses Array', parameters: { fieldToSplitOut: 'responses', options: {} }, position: [640, 140], notes: 'Extracts items from the responses array, creating individual execution streams for each response item.', notesInFlow: true }
});

const sort_by_Response_ID = node({
  type: 'n8n-nodes-base.sort',
  version: 1,
  config: { name: 'Sort by Response ID', parameters: { sortFieldsUi: { sortField: [{ fieldName: 'responseId' }] }, options: {} }, position: [860, 140], notes: 'Enforces consistent sorting order across responses based on their responseId key before embedding extraction.', notesInFlow: true }
});

const calculate_Text_Embedding = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: { name: 'Calculate Text Embedding', parameters: { method: 'POST', url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent', authentication: 'predefinedCredentialType', nodeCredentialType: 'googlePalmApi', sendBody: true, specifyBody: 'json', jsonBody: expr('{\n  "content": {\n    "parts": [\n      {\n        "text": {{ $json?.text?.trim() ? $json?.text?.trim().toJsonString() : \'"no text"\' }}\n      }\n    ]\n  },\n  "output_dimensionality": 1536,\n  "taskType": "RETRIEVAL_DOCUMENT"\n}'), options: {} }, credentials: { googlePalmApi: newCredential('Google Gemini API Key', 'QWpzmztRGaBDrcyt') }, position: [1080, 140], notes: 'Extracts vector embeddings (1536-dimensional) of the input text using the Google Gemini text embedding API.', notesInFlow: true }
});

const postgres_Similarity_Search = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: { name: 'Postgres Similarity Search', parameters: { operation: 'executeQuery', query: expr('SELECT * FROM search_similar_items(\'{{ $json.id }}\', 0.7, 3);'), options: {} }, credentials: { postgres: newCredential('Postgres Connection', 'eeD1OBkCt6cpC61L') }, position: [1300, 140], notes: 'Performs similarity search in a pgvector PostgreSQL table using cosine distance to retrieve the most similar historical examples.', notesInFlow: true }
});

const format_RAG_Examples = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'Format RAG Examples', parameters: { assignments: { assignments: [{ id: 'format-example', name: 'example', value: expr('<example_{{ $itemIndex }}>\n<inputs>\n<input_text>{{ $json.inputText }}</input_text>\n</inputs>\n<output_text>{{ $json.outputText }}</output_text>\n</example_{{ $itemIndex }}>'), type: 'string' }] }, options: {} }, position: [1520, 140], notes: 'Formats each retrieved historical match into a structured XML representation containing input_text and output_text fields.', notesInFlow: true }
});

const aggregate_Examples = node({
  type: 'n8n-nodes-base.aggregate',
  version: 1,
  config: { name: 'Aggregate Examples', parameters: { fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: 'example', renameField: true, outputFieldName: 'examples' }] }, options: {} }, position: [1720, 140], notes: 'Combines individual formatted XML matches back into a single unified list of RAG examples.', notesInFlow: true }
});

const xML_Examples_Wrapper = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'XML Examples Wrapper', parameters: { assignments: { assignments: [{ id: 'xml-wrapper', name: 'examples', value: expr('<examples>\n{{ $json.examples.join(\'\\n\\n\') }}\n</examples>'), type: 'string' }] }, options: {} }, position: [1940, 140], notes: 'Wraps all aggregated examples inside a single <examples> XML root tag to maintain XML formatting compatibility.', notesInFlow: true }
});

const write_Response_with_AI = node({
  type: '@n8n/n8n-nodes-langchain.chainLlm',
  version: 1.9,
  config: { name: 'Write Response with AI', parameters: { promptType: 'define', text: expr('# Instructions\n<instructions>\n<goal>\nProcess the text according to standard rules.\n</goal>\n\n<context>\nYou are an assistant.\n</context>\n\n{{ $json.examples }}\n\n<output_format>\nPlain text output.\n</output_format>\n</instructions>\n\n# Inputs\n<inputs>\n<text>{{ $json.text }}</text>\n</inputs>'), messages: { messageValues: [{ message: 'You are a professional assistant.' }] } }, position: [2160, 140], notes: 'Invokes Google Gemini Chat with a structured XML prompt that injects dynamic retrieval-augmented (RAG) examples into system instructions.', notesInFlow: true, subnodes: { model: google_Gemini_Model } }
});

const wf = workflow('gpcJhDkl1MTBDAZl', 'Data Orchestration and RAG', { binaryMode: 'separate', description: 'Standard template for advanced parallel data flow and similarity search.', availableInMCP: true, executionOrder: 'v1' });

export default wf
  .add(start_Trigger
  .to([
    fetch_Context_Metadata,
    fetch_Stream_Content]))
  .add(fetch_Context_Metadata.to(merge_Data_by_Position.input(0)))
  .add(fetch_Stream_Content.to(merge_Data_by_Position.input(1)))
  .add(merge_Data_by_Position)
  .to(split_Responses_Array
  .to(sort_by_Response_ID)
  .to(calculate_Text_Embedding)
  .to(postgres_Similarity_Search)
  .to(format_RAG_Examples)
  .to(aggregate_Examples)
  .to(xML_Examples_Wrapper)
  .to(write_Response_with_AI))
