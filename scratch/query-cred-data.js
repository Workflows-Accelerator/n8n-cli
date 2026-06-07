import pg from 'pg';

const dbUrl = "postgres://C8TAjhAoyCkq0a2j:3923ab46217cc278fa28fa8482248ba913cbf18c19a484deb4d116b10f268b8c@n8n-db.parris.app:443/n8n_prod_db?sslmode=verify-full";

async function main() {
  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();

  const res = await client.query('SELECT id, name, type, data FROM credentials_entity LIMIT 3;');
  for (const row of res.rows) {
    console.log(`ID: ${row.id}, Name: ${row.name}, Type: ${row.type}`);
    console.log(`Data (length: ${row.data?.length}):`, row.data?.substring(0, 100));
  }

  await client.end();
}

main().catch(console.error);
