import { Command } from 'commander';
import { getConnectionInfo } from '../config.js';
import { withMcp } from '../mcp-client.js';
import * as output from '../output.js';

function filterMarkdownByQuery(text: string, query: string): string {
  // Split by markdown headers or tags at the start of a line
  const blocks = text.split(/(?=^(?:#+|<[a-zA-Z0-9_-]+>))/m);
  const matchedBlocks = blocks.filter(block => 
    block.toLowerCase().includes(query.toLowerCase())
  );
  
  if (matchedBlocks.length === 0) {
    return `No matching SDK sections found for query: "${query}"`;
  }
  
  return matchedBlocks.join('\n').trim();
}

export function sdkCommand(program: Command) {
  program
    .command('sdk')
    .description('Retrieve n8n Workflow SDK reference documentation')
    .argument('[section]', 'optional section (patterns, expressions, functions, rules, import, guidelines, design, all) or search query', 'all')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (section, options) => {
      try {
        const { mcpCommand, accessToken } = getConnectionInfo(options);

        const validSections = ['patterns', 'expressions', 'functions', 'rules', 'import', 'guidelines', 'design', 'all'];
        const isQuery = !validSections.includes(section);
        const mcpSection = isQuery ? 'all' : section;

        if (isQuery) {
          output.log(`Retrieving SDK documentation and filtering by query "${section}"...`);
        } else {
          output.log(`Retrieving SDK documentation for section '${section}'...`);
        }

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          const result = await mcp.callTool('get_sdk_reference', {
            section: mcpSection,
          });

          let text = result.content?.find((c: any) => c.type === 'text')?.text || '';
          if (!text) {
            output.log('No SDK reference found.');
            return;
          }

          if (isQuery) {
            text = filterMarkdownByQuery(text, section);
          }
          output.log(text);
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
