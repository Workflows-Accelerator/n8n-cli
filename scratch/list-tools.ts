import { getConnectionInfo } from '../src/config.js';
import { withMcp } from '../src/mcp-client.js';

async function main() {
  const { mcpCommand, accessToken } = getConnectionInfo();
  await withMcp(mcpCommand, accessToken, async (mcp) => {
    const tools = await (mcp as any).client.listTools();
    console.log('Available tools and schemas:');
    for (const tool of tools.tools) {
      console.log(`\n========================================`);
      console.log(`Tool: ${tool.name}`);
      console.log(`Description: ${tool.description}`);
      console.log(`Input Schema:`, JSON.stringify(tool.inputSchema, null, 2));
    }
  });
}

main().catch(console.error);
