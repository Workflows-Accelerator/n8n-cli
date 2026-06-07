import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const dbUrl = process.argv[2] || process.env.N8N_DB_URL;

if (!dbUrl) {
  console.error('Error: Please provide PostgreSQL database URL as argument or set N8N_DB_URL in your environment.');
  process.exit(1);
}

async function main() {
  console.log('Connecting to PostgreSQL database...');
  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('Connected successfully!');

    // 1. List all tables in public schema
    console.log('\n--- Tables in public schema ---');
    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    const tables = tablesRes.rows.map(r => r.table_name);
    console.log(tables.join(', '));

    // Check if workflow_entity and folder exist
    const hasWorkflow = tables.includes('workflow_entity');
    const hasFolder = tables.includes('folder');

    console.log(`\nHas workflow_entity table: ${hasWorkflow}`);
    console.log(`Has folder table: ${hasFolder}`);

    if (hasWorkflow) {
      console.log('\n--- Columns in workflow_entity ---');
      const colsRes = await client.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'workflow_entity'
        ORDER BY ordinal_position;
      `);
      for (const col of colsRes.rows) {
        console.log(`  - ${col.column_name} (${col.data_type})`);
      }
    }

    if (hasFolder) {
      console.log('\n--- Columns in folder ---');
      const colsRes = await client.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'folder'
        ORDER BY ordinal_position;
      `);
      for (const col of colsRes.rows) {
        console.log(`  - ${col.column_name} (${col.data_type})`);
      }
    }

    // Check if there is any other folder/project table
    const folderTables = tables.filter(t => t.includes('folder') || t.includes('project') || t.includes('relation'));
    for (const ft of folderTables) {
      if (ft !== 'workflow_entity' && ft !== 'folder') {
        console.log(`\n--- Columns in ${ft} ---`);
        const colsRes = await client.query(`
          SELECT column_name, data_type 
          FROM information_schema.columns 
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position;
        `, [ft]);
        for (const col of colsRes.rows) {
          console.log(`  - ${col.column_name} (${col.data_type})`);
        }
      }
    }

    // Attempt a test query if both tables exist
    if (hasWorkflow && hasFolder) {
      console.log('\n--- Attempting folder relationship test query ---');
      try {
        // Let's see if there is a direct column or joint table
        // We'll select first 5 workflows and see their column values related to project/folder
        const sampleWorkflowsRes = await client.query('SELECT * FROM workflow_entity LIMIT 2;');
        console.log('Sample workflow columns structure:', Object.keys(sampleWorkflowsRes.rows[0] || {}));
        
        // Let's see first 2 folders
        const sampleFoldersRes = await client.query('SELECT * FROM folder LIMIT 2;');
        console.log('Sample folder columns structure:', Object.keys(sampleFoldersRes.rows[0] || {}));
      } catch (e) {
        console.error('Test query failed:', e.message);
      }
    }

  } catch (err) {
    console.error('Database query error:', err.stack);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
