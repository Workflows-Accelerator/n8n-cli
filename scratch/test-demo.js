import pg from 'pg';
import { McpClient } from '../src/mcp-client.js';
import { Command } from 'commander';
import { testCommand } from '../src/commands/test.js';

// Set environment variable for DB URL to trigger database connection flow in CLI
process.env.N8N_DB_URL = 'postgresql://mockuser:mockpass@localhost:5432/mockdb';

// 1. Stub the PostgreSQL database client
pg.Client = class MockClient {
  constructor(config) {
    console.log('[MOCK DB] Client initialized.');
  }
  async connect() {
    console.log('[MOCK DB] Connected to PostgreSQL.');
  }
  async query(sql, params) {
    console.log(`[MOCK DB] query: ${sql.trim().replace(/\s+/g, ' ')}`, params || '');
    if (sql.includes('SELECT id FROM folder')) {
      return { rows: [] }; // Simulate that the '[Temp Testing]' folder does not exist yet
    }
    if (sql.includes('INSERT INTO folder')) {
      return { rows: [] }; // Simulate folder creation
    }
    return { rows: [] };
  }
  async end() {
    console.log('[MOCK DB] Disconnected.');
  }
};
pg.default = { Client: pg.Client };

// 2. Stub the McpClient methods
McpClient.prototype.connect = async function(commandStr, accessToken) {
  console.log('[MOCK MCP] Connected to n8n MCP instance.');
};

McpClient.prototype.callTool = async function(name, args) {
  console.log(`[MOCK MCP] callTool: '${name}'`);
  console.log(`  arguments:`, JSON.stringify(args, null, 2));
  
  if (name === 'create_workflow_from_code') {
    return {
      content: [{ type: 'text', text: 'Workflow created successfully. ID: temp_workflow_abc123' }]
    };
  }
  if (name === 'prepare_test_pin_data') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          nodeSchemas: {
            "When Clicking Execute Workflow": {
              type: "object",
              properties: {
                myVar: { type: "string" }
              }
            }
          }
        })
      }]
    };
  }
  if (name === 'test_workflow') {
    return {
      content: [{ type: 'text', text: 'Test execution completed successfully on n8n!\nOutput data: [{"json": {"status": "success", "myVar": "mock-string"}}].' }]
    };
  }
  if (name === 'archive_workflow') {
    return {
      content: [{ type: 'text', text: 'Workflow temp_workflow_abc123 archived successfully.' }]
    };
  }
  return {};
};

// 3. Setup and run commander testCommand
const program = new Command();
testCommand(program);

console.log('--- STARTING DEMO RUN ---');
try {
  await program.parseAsync([
    'node',
    'cli.js',
    'test',
    'n8n/workflows/Test Folder/Test Workflow.workflow.ts'
  ]);
} catch (err) {
  console.error('Demo error:', err);
}
console.log('--- DEMO RUN FINISHED ---');
