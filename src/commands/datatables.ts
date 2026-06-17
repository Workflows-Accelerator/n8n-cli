import { Command } from 'commander';
import pg from 'pg';
import { getConnectionInfo } from '../config.js';
import * as output from '../output.js';

export function datatablesCommand(program: Command) {
  const datatables = program
    .command('datatables')
    .description('Inspect and update n8n database tracking datatables');

  datatables
    .command('list', { isDefault: true })
    .description('List user tables in n8n PostgreSQL database')
    .option('--json', 'output raw JSON format')
    .option('--db-url <url>', 'n8n PostgreSQL database connection URL')
    .action(async (options) => {
      try {
        const { dbUrl } = getConnectionInfo(options);
        if (!dbUrl) {
          throw new Error('Database URL (dbUrl) is required to list tables. Configure it globally or pass via --db-url.');
        }

        const pgModule = pg as any;
        const ClientClass = pgModule.Client || pgModule.default?.Client || pgModule;
        const client = new ClientClass({
          connectionString: dbUrl,
          ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false')) ? false : { rejectUnauthorized: false }
        });

        await client.connect();
        try {
          const res = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
            ORDER BY table_name;
          `);

          if (output.getJsonMode()) {
            console.log(JSON.stringify(res.rows.map(r => r.table_name), null, 2));
            return;
          }

          if (res.rows.length === 0) {
            output.log('No tables found.');
            return;
          }

          const headers = ['Table Name'];
          const rows = res.rows.map(r => [r.table_name]);
          output.table(headers, rows);
        } finally {
          await client.end();
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  datatables
    .command('query <table-name>')
    .description('Query rows from a database table')
    .option('--filter <filter>', 'SQL WHERE filter condition')
    .option('--limit <n>', 'limit the number of rows returned', parseInt)
    .option('--json', 'output raw JSON format')
    .option('--db-url <url>', 'n8n PostgreSQL database connection URL')
    .action(async (tableName, options) => {
      try {
        const { dbUrl } = getConnectionInfo(options);
        if (!dbUrl) {
          throw new Error('Database URL (dbUrl) is required to query tables. Configure it globally or pass via --db-url.');
        }

        const pgModule = pg as any;
        const ClientClass = pgModule.Client || pgModule.default?.Client || pgModule;
        const client = new ClientClass({
          connectionString: dbUrl,
          ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false')) ? false : { rejectUnauthorized: false }
        });

        const limit = options.limit !== undefined ? options.limit : 100;
        let queryStr = `SELECT * FROM "${tableName}"`;
        if (options.filter) {
          queryStr += ` WHERE ${options.filter}`;
        }
        queryStr += ` LIMIT ${limit};`;

        await client.connect();
        try {
          const res = await client.query(queryStr);

          if (output.getJsonMode()) {
            console.log(JSON.stringify(res.rows, null, 2));
            return;
          }

          if (res.rows.length === 0) {
            output.log('No rows returned.');
            return;
          }

          const headers = res.fields.map(f => f.name);
          const rows = res.rows.map(row => 
            headers.map(h => {
              const val = row[h];
              if (val === null) return '';
              if (typeof val === 'object') return JSON.stringify(val);
              return String(val);
            })
          );

          output.table(headers, rows);
        } finally {
          await client.end();
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  datatables
    .command('update <table-name>')
    .description('Update rows in a database table')
    .option('--filter <filter>', 'SQL WHERE filter condition')
    .option('--data <json>', 'JSON data containing columns and values to update')
    .option('--db-url <url>', 'n8n PostgreSQL database connection URL')
    .action(async (tableName, options) => {
      try {
        const { dbUrl } = getConnectionInfo(options);
        if (!dbUrl) {
          throw new Error('Database URL (dbUrl) is required to update tables. Configure it globally or pass via --db-url.');
        }

        if (!options.data) {
          throw new Error('Data payload (--data) is required for update operation.');
        }

        let updateData: any;
        try {
          updateData = JSON.parse(options.data);
        } catch (e) {
          throw new Error(`Failed to parse data JSON: ${e instanceof Error ? e.message : String(e)}`);
        }

        const pgModule = pg as any;
        const ClientClass = pgModule.Client || pgModule.default?.Client || pgModule;
        const client = new ClientClass({
          connectionString: dbUrl,
          ssl: (dbUrl.includes('localhost') || dbUrl.includes('sslmode=disable') || dbUrl.includes('ssl=false')) ? false : { rejectUnauthorized: false }
        });

        const keys = Object.keys(updateData);
        if (keys.length === 0) {
          throw new Error('No data columns provided to update.');
        }

        const setClauses = keys.map((key, index) => `"${key}" = $${index + 1}`);
        const values = keys.map(key => updateData[key]);

        let queryStr = `UPDATE "${tableName}" SET ${setClauses.join(', ')}`;
        if (options.filter) {
          queryStr += ` WHERE ${options.filter}`;
        }
        queryStr += ';';

        await client.connect();
        try {
          const res = await client.query(queryStr, values);
          output.log(`Successfully updated table '${tableName}' (${res.rowCount} rows affected).`);
        } finally {
          await client.end();
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
