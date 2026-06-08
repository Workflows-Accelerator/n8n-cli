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
    position: [2400, 250],
    notesInFlow: true,
    notes: 'Specifies the chat model to be used by the LLM chain. Setting a low temperature forces deterministic and factual generations.'
  }
});

const start_Trigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: {
    name: 'Start Trigger',
    position: [0, 150],
    notesInFlow: true,
    notes: 'Starts the complex orchestration manually. Can be replaced with a schedule, webhook, or queue listener in production.'
  }
});

const fetch_Context_Metadata = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: {
    name: 'Fetch Context Metadata',
    position: [200, 50],
    notesInFlow: true,
    notes: 'First branch: Fetches high-level schema settings, context values, or identifier mappings from an external system.'
  }
});

const fetch_Stream_Content = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: {
    name: 'Fetch Stream Content',
    position: [200, 250],
    notesInFlow: true,
    notes: 'Second branch: Fetches the primary text content or stream items to be processed in parallel with the metadata context.'
  }
});

const merge_Data_by_Position = node({
  type: 'n8n-nodes-base.merge',
  version: 3.2,
  config: {
    name: 'Merge Data by Position',
    parameters: {
      mode: 'combine',
      combineBy: 'combineByPosition',
      options: {}
    },
    position: [450, 150],
    notesInFlow: true,
    notes: 'Combines data from both branches (metadata context and primary stream items) by position, creating a single unified data context.'
  }
});

const split_Responses_Array = node({
  type: 'n8n-nodes-base.splitOut',
  version: 1,
  config: {
    name: 'Split Responses Array',
    parameters: {
      fieldToSplitOut: 'responses',
      options: {}
    },
    position: [700, 150],
    notesInFlow: true,
    notes: 'Extracts items from the responses array, creating individual execution streams for each response item.'
  }
});

const sort_by_Response_ID = node({
  type: 'n8n-nodes-base.sort',
  version: 1,
  config: {
    name: 'Sort by Response ID',
    parameters: {
      sortFieldsUi: {
        sortField: [
          { fieldName: 'responseId' }
        ]
      },
      options: {}
    },
    position: [900, 150],
    notesInFlow: true,
    notes: 'Enforces consistent sorting order across responses based on their responseId key before embedding extraction.'
  }
});

const calculate_Text_Embedding = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Calculate Text Embedding',
    parameters: {
      method: 'POST',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googlePalmApi',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr(
        '={\n' +
        '  "content": {\n' +
        '    "parts": [\n' +
        '      {\n' +
        '        "text": {{ $json?.text?.trim() ? $json?.text?.trim().toJsonString() : \'"no text"\' }}\n' +
        '      }\n' +
        '    ]\n' +
        '  },\n' +
        '  "output_dimensionality": 1536,\n' +
        '  "taskType": "RETRIEVAL_DOCUMENT"\n' +
        '}'
      ),
      options: {}
    },
    credentials: {
      googlePalmApi: newCredential('Google Gemini API Key', 'QWpzmztRGaBDrcyt')
    },
    position: [1150, 150],
    notesInFlow: true,
    notes: 'Extracts vector embeddings (1536-dimensional) of the input text using the Google Gemini text embedding API.'
  }
});

const postgres_Similarity_Search = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Postgres Similarity Search',
    parameters: {
      operation: 'executeQuery',
      query: '=SELECT * FROM search_similar_items(\'{{ $json.id }}\', 0.7, 3);',
      options: {}
    },
    credentials: {
      postgres: newCredential('Postgres Connection')
    },
    position: [1400, 150],
    notesInFlow: true,
    notes: "Performs similarity search in a pgvector PostgreSQL table using cosine distance to retrieve the most similar historical examples."
  }
});

const format_RAG_Examples = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Format RAG Examples',
    parameters: {
      assignments: {
        assignments: [
          {
            id: 'format-example',
            name: 'example',
            value: expr(
              '<example_{{ $itemIndex }}>\n' +
              '<inputs>\n' +
              '<input_text>{{ $json.inputText }}</input_text>\n' +
              '</inputs>\n' +
              '<output_text>{{ $json.outputText }}</output_text>\n' +
              '</example_{{ $itemIndex }}>'
            ),
            type: 'string'
          }
        ]
      },
      options: {}
    },
    position: [1650, 150],
    notesInFlow: true,
    notes: 'Formats each retrieved historical match into a structured XML representation containing input_text and output_text fields.'
  }
});

const aggregate_Examples = node({
  type: 'n8n-nodes-base.aggregate',
  version: 1,
  config: {
    name: 'Aggregate Examples',
    parameters: {
      fieldsToAggregate: {
        fieldToAggregate: [
          { fieldToAggregate: 'example', renameField: true, outputFieldName: 'examples' }
        ]
      },
      options: {}
    },
    position: [1900, 150],
    notesInFlow: true,
    notes: 'Combines individual formatted XML matches back into a single unified list of RAG examples.'
  }
});

const xml_Examples_Wrapper = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'XML Examples Wrapper',
    parameters: {
      assignments: {
        assignments: [
          {
            id: 'xml-wrapper',
            name: 'examples',
            value: expr('<examples>\n{{ $json.examples.join(\'\\n\\n\') }}\n</examples>'),
            type: 'string'
          }
        ]
      },
      options: {}
    },
    position: [2150, 150],
    notesInFlow: true,
    notes: 'Wraps all aggregated examples inside a single <examples> XML root tag to maintain XML formatting compatibility.'
  }
});

const write_Response_with_AI = node({
  type: '@n8n/n8n-nodes-langchain.chainLlm',
  version: 1.9,
  config: {
    name: 'Write Response with AI',
    parameters: {
      promptType: 'define',
      text: expr(
        '=# Instructions\n' +
        '<instructions>\n' +
        '<goal>\n' +
        'Process the text according to standard rules.\n' +
        '</goal>\n\n' +
        '<context>\n' +
        'You are an assistant.\n' +
        '</context>\n\n' +
        '{{ $json.examples }}\n\n' +
        '<output_format>\n' +
        'Plain text output.\n' +
        '</output_format>\n' +
        '</instructions>\n\n' +
        '# Inputs\n' +
        '<inputs>\n' +
        '<text>{{ $json.text }}</text>\n' +
        '</inputs>'
      ),
      messages: {
        messageValues: [
          { message: 'You are a professional assistant.' }
        ]
      }
    },
    position: [2400, 50],
    subnodes: {
      model: google_Gemini_Model
    },
    notesInFlow: true,
    notes: 'Invokes Google Gemini Chat with a structured XML prompt that injects dynamic retrieval-augmented (RAG) examples into system instructions.'
  }
});

const wf = workflow('data-orchestration-and-rag', 'Data Orchestration and RAG', {
  executionOrder: 'v1',
  availableInMCP: true,
  binaryMode: 'separate',
  description: 'Standard template for advanced parallel data flow and similarity search.'
});

// Add all nodes to workflow builder
wf.add(start_Trigger);
wf.add(fetch_Context_Metadata);
wf.add(fetch_Stream_Content);
wf.add(merge_Data_by_Position);
wf.add(split_Responses_Array);
wf.add(sort_by_Response_ID);
wf.add(calculate_Text_Embedding);
wf.add(postgres_Similarity_Search);
wf.add(format_RAG_Examples);
wf.add(aggregate_Examples);
wf.add(xml_Examples_Wrapper);
wf.add(write_Response_with_AI);

// Connections from Trigger
start_Trigger.to(fetch_Context_Metadata);
start_Trigger.to(fetch_Stream_Content);

// Inputs to Merge
fetch_Context_Metadata.to(merge_Data_by_Position.input(0));
fetch_Stream_Content.to(merge_Data_by_Position.input(1));

// Sequential chain after Merge
merge_Data_by_Position
  .to(split_Responses_Array)
  .to(sort_by_Response_ID)
  .to(calculate_Text_Embedding)
  .to(postgres_Similarity_Search)
  .to(format_RAG_Examples)
  .to(aggregate_Examples)
  .to(xml_Examples_Wrapper)
  .to(write_Response_with_AI);

export default wf;
