import pg from 'pg';

const dbUrl = "postgres://C8TAjhAoyCkq0a2j:3923ab46217cc278fa28fa8482248ba913cbf18c19a484deb4d116b10f268b8c@n8n-db.parris.app:443/n8n_prod_db?sslmode=require";
const projectId = "5U5vIHIc1Ug5eVLK";

async function main() {
  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  const res = await client.query(
    'SELECT id, name, "parentFolderId" FROM folder WHERE "projectId" = $1;',
    [projectId]
  );
  console.log('Folders count:', res.rows.length);
  for (const row of res.rows) {
    console.log(`ID: ${row.id.padEnd(20)} | Name: ${row.name.padEnd(25)} | Parent ID: ${row.parentFolderId}`);
  }

  await client.end();
}

main().catch(console.error);
