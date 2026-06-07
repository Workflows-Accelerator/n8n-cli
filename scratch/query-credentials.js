import pg from 'pg';

const dbUrl = "postgres://C8TAjhAoyCkq0a2j:3923ab46217cc278fa28fa8482248ba913cbf18c19a484deb4d116b10f268b8c@n8n-db.parris.app:443/n8n_prod_db?sslmode=verify-full";

async function main() {
  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();

  console.log('--- Sample credentials_entity rows ---');
  const creds = await client.query('SELECT id, name, type, "isManaged", "isGlobal", "isResolvable", "createdAt", "updatedAt" FROM credentials_entity LIMIT 5;');
  console.log(JSON.stringify(creds.rows, null, 2));

  console.log('\n--- Sample shared_credentials rows ---');
  const shared = await client.query('SELECT * FROM shared_credentials LIMIT 5;');
  console.log(JSON.stringify(shared.rows, null, 2));

  await client.end();
}

main().catch(console.error);
