import pg from 'pg';

const dbUrl = "postgres://C8TAjhAoyCkq0a2j:3923ab46217cc278fa28fa8482248ba913cbf18c19a484deb4d116b10f268b8c@n8n-db.parris.app:443/n8n_prod_db?sslmode=require";

const pgClient = pg;
const ClientClass = pgClient.Client || pgClient.default?.Client || pgClient;
const client = new ClientClass({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  await client.connect();
  const res = await client.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'folder' AND table_schema = 'public';
  `);
  console.log(JSON.stringify(res.rows, null, 2));
  await client.end();
}

main().catch(console.error);
