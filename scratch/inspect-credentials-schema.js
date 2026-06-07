import pg from 'pg';

const dbUrl = "postgres://C8TAjhAoyCkq0a2j:3923ab46217cc278fa28fa8482248ba913cbf18c19a484deb4d116b10f268b8c@n8n-db.parris.app:443/n8n_prod_db?sslmode=verify-full";

async function main() {
  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();

  // 1. List all tables that might relate to credentials
  const tablesRes = await client.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name LIKE '%cred%'
    ORDER BY table_name;
  `);
  console.log('Credential-related tables:', tablesRes.rows.map(r => r.table_name));

  for (const table of tablesRes.rows.map(r => r.table_name)) {
    console.log(`\n--- Columns in ${table} ---`);
    const colsRes = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position;
    `, [table]);
    for (const col of colsRes.rows) {
      console.log(`  - ${col.column_name} (${col.data_type}), Nullable: ${col.is_nullable}`);
    }

    try {
      const sampleRes = await client.query(`SELECT * FROM "${table}" LIMIT 1;`);
      if (sampleRes.rows.length > 0) {
        console.log(`Sample row from ${table}:`, Object.keys(sampleRes.rows[0]));
      } else {
        console.log(`Table ${table} is empty.`);
      }
    } catch (e) {
      console.error(`Failed to fetch sample for ${table}:`, e.message);
    }
  }

  await client.end();
}

main().catch(console.error);
