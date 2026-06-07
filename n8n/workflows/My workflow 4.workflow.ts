const mCP_Client = tool({ type: '@n8n/n8n-nodes-langchain.mcpClientTool', version: 1.2, config: { name: 'MCP Client', parameters: { endpointUrl: expr('https://n8n.parris.app/mcp-server/http'), authentication: 'bearerAuth', include: 'selected', options: {} }, position: [464, 272] } });

const when_chat_message_received = trigger({
  type: '@n8n/n8n-nodes-langchain.chatTrigger',
  version: 1.4,
  config: { name: 'When chat message received', parameters: { options: {} }, webhookId: '68e0261c-58d2-4e0a-9740-167d05a0290b' }
});

const aI_Agent = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 3.1,
  config: { name: 'AI Agent', parameters: { options: {} }, position: [208, 0], subnodes: { tools: [mCP_Client] } }
});

const wf = workflow('8f7caSnjOUvacdnM', 'My workflow 4', { executionOrder: 'v1', binaryMode: 'separate', timeSavedMode: 'fixed', callerPolicy: 'workflowsFromSameOwner', availableInMCP: true });

export default wf
  .add(when_chat_message_received)
  .to(aI_Agent)