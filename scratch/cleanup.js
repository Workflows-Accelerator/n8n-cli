import pg from 'pg';

const dbUrl = "postgres://C8TAjhAoyCkq0a2j:3923ab46217cc278fa28fa8482248ba913cbf18c19a484deb4d116b10f268b8c@n8n-db.parris.app:443/n8n_prod_db?sslmode=verify-full";

async function main() {
  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();

  await client.query('DELETE FROM shared_credentials WHERE "credentialsId" = $1;', ['SnGmdioXDIY7Hv24']);
  await client.query('DELETE FROM credentials_entity WHERE id = $1;', ['SnGmdioXDIY7Hv24']);
  
  console.log('Dummy credential cleaned up.');

  await client.end();
}

main().catch(console.error);
