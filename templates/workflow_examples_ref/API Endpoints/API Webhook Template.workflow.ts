const pOST_api_v1_resource = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: { name: 'POST /api/v1/resource', parameters: { httpMethod: 'POST', path: 'api/v1/resource', authentication: 'headerAuth', responseMode: 'responseNode', options: {} }, credentials: { httpHeaderAuth: newCredential('API Key', 'hmsiyDLCgLgKDP17') }, position: [-200, 0], webhookId: '6d7dd5e8-7194-4e90-84c5-473d9de973f8', notes: 'HTTP POST trigger serving as the entry point for this API. Authenticated via header API Key, which is critical for securing SaaS backend API calls to restrict access. For public endpoints or testing, authentication can be set to "none".', notesInFlow: true }
});

const process_Request = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: { name: 'Process Request', position: [20, 0], notes: 'Placeholder for request validation, business logic, data transformation, or integration steps before generating the final HTTP response.', notesInFlow: true }
});

const respond_to_Client = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: { name: 'Respond to Client', parameters: { respondWith: 'json', responseBody: expr('{\n  "status": "success",\n  "data": {{ $json }}\n}'), options: {} }, position: [240, 0], notes: 'Custom Webhook Response node that terminates the client connection and outputs a structured JSON payload containing execution status and processed data.', notesInFlow: true }
});

const wf = workflow('DC4icTwjYm2boKY5', 'API Webhook Template', { binaryMode: 'separate', description: 'Standard template for building authenticated webhook endpoints with custom responses.', availableInMCP: true, executionOrder: 'v1' });

export default wf
  .add(pOST_api_v1_resource)
  .to(process_Request)
  .to(respond_to_Client)
