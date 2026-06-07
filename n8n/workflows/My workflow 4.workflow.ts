const when_chat_message_received = trigger({
  type: '@n8n/n8n-nodes-langchain.chatTrigger',
  version: 1.4,
  config: { name: 'When chat message received', parameters: { options: {} }, webhookId: '68e0261c-58d2-4e0a-9740-167d05a0290b' }
});

const aI_Agent = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 3.1,
  config: { name: 'AI Agent', parameters: { options: {} }, position: [208, 0] }
});

const mCP_Client = node({
  type: '@n8n/n8n-nodes-langchain.mcpClientTool',
  version: 1.2,
  config: { name: 'MCP Client', parameters: { endpointUrl: expr('https://n8n.parris.app/mcp-server/http'), authentication: 'bearerAuth', include: 'selected', options: {} }, credentials: { httpBearerAuth: newCredential('n8n MCP', '3lY34YWz2APpHSjV') }, position: [208, 400] }
});

const mCP_Client1 = node({
  type: '@n8n/n8n-nodes-langchain.mcpClient',
  version: 1,
  config: { name: 'MCP Client1', parameters: { endpointUrl: 'https://n8n.parris.app/mcp-server/http', authentication: 'bearerAuth', tool: { __rl: true, value: 'get_workflow_details', mode: 'list', cachedResultName: 'get_workflow_details' }, parameters: { mappingMode: 'defineBelow', value: { workflowId: 'nplfril1UNTXXGee' }, matchingColumns: ['workflowId'], schema: [{ id: 'workflowId', displayName: 'workflowId', defaultMatch: false, required: true, display: true, type: 'string', removed: false }], attemptToConvertTypes: false, convertFieldsToString: false }, options: {} }, credentials: { httpBearerAuth: newCredential('n8n MCP', '3lY34YWz2APpHSjV') }, position: [416, 400] }
});

const wf = workflow('8f7caSnjOUvacdnM', 'My workflow 4', { executionOrder: 'v1', binaryMode: 'separate', timeSavedMode: 'fixed', callerPolicy: 'workflowsFromSameOwner', availableInMCP: true });

export default wf
  .add(when_chat_message_received)
  .to(aI_Agent)
  .add(mCP_Client)
  .add(mCP_Client1)