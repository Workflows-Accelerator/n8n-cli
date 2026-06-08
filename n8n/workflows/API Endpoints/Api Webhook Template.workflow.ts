const post_Api_V1_Resource = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: { 
    name: 'POST /api/v1/resource', 
    parameters: { 
      httpMethod: 'POST', 
      path: 'api/v1/resource', 
      authentication: 'headerAuth', 
      responseMode: 'responseNode', 
      options: {} 
    }, 
    credentials: { 
      httpHeaderAuth: newCredential('API Key', 'hmsiyDLCgLgKDP17') 
    },
    position: [-200, 0],
    notesInFlow: true,
    notes: 'HTTP POST trigger serving as the entry point for this API. Authenticated via header API Key, which is critical for securing SaaS backend API calls to restrict access. For public endpoints or testing, authentication can be set to "none".'
  }
});

const process_Request = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: { 
    name: 'Process Request',
    position: [0, 0],
    notesInFlow: true,
    notes: 'Placeholder for request validation, business logic, data transformation, or integration steps before generating the final HTTP response.'
  }
});

const respond_to_Client = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: { 
    name: 'Respond to Client', 
    parameters: { 
      respondWith: 'json', 
      responseBody: expr('={\n  "status": "success",\n  "data": {{ $json }}\n}'), 
      options: {} 
    }, 
    position: [200, 0],
    notesInFlow: true,
    notes: 'Custom Webhook Response node that terminates the client connection and outputs a structured JSON payload containing execution status and processed data.'
  }
});

const wf = workflow('api-webhook-template', 'API Webhook Template', { 
  executionOrder: 'v1', 
  availableInMCP: true, 
  binaryMode: 'separate',
  description: 'Standard template for building authenticated webhook endpoints with custom responses.'
});

export default wf
  .add(post_Api_V1_Resource)
  .to(process_Request)
  .to(respond_to_Client);
