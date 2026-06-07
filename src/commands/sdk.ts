import { Command } from 'commander';
import { getConnectionInfo } from '../config.js';
import { withMcp } from '../mcp-client.js';
import * as output from '../output.js';

export function sdkCommand(program: Command) {
  program
    .command('sdk')
    .description('Retrieve n8n Workflow SDK reference documentation')
    .argument('[section]', 'optional section: patterns, expressions, functions, rules, import, guidelines, design, or all', 'all')
    .option('--mcp-command <cmd>', 'override MCP server start command')
    .option('--access-token <token>', 'override n8n access token')
    .action(async (section, options) => {
      try {
        const { mcpCommand, accessToken } = getConnectionInfo(options);

        // Map section names to what the MCP tool expects
        const validSections = ['patterns', 'expressions', 'functions', 'rules', 'import', 'guidelines', 'design', 'all'];
        if (!validSections.includes(section)) {
          throw new Error(`Invalid section: ${section}. Must be one of: ${validSections.join(', ')}`);
        }

        output.log(`Retrieving SDK documentation for section '${section}'...`);

        await withMcp(mcpCommand, accessToken, async (mcp) => {
          const result = await mcp.callTool('get_sdk_reference', {
            section,
          });

          const text = result.content?.find((c: any) => c.type === 'text')?.text;
          output.log(text || 'No SDK reference found.');
        });
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
