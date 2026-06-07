import pg from 'pg';

const dbUrl = "postgres://C8TAjhAoyCkq0a2j:3923ab46217cc278fa28fa8482248ba913cbf18c19a484deb4d116b10f268b8c@n8n-db.parris.app:443/n8n_prod_db?sslmode=verify-full";

function generateId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

async function main() {
  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();

  const projectId = '5U5vIHIc1Ug5eVLK';
  const credId = generateId();
  const name = 'Test Dummy Credential';
  const type = 'googlePalmApi';
  const data = ''; // empty data

  console.log(`Inserting credential into credentials_entity with ID: ${credId}...`);
  await client.query(`
    INSERT INTO credentials_entity (id, name, type, data, "createdAt", "updatedAt", "isManaged", "isGlobal", "isResolvable", "resolvableAllowFallback")
    VALUES ($1, $2, $3, $4, NOW(), NOW(), false, false, false, false);
  `, [credId, name, type, data]);

  console.log(`Sharing credential with project: ${projectId}...`);
  await client.query(`
    INSERT INTO shared_credentials ("credentialsId", "projectId", "role", "createdAt", "updatedAt")
    VALUES ($1, $2, 'credential:owner', NOW(), NOW());
  `, [credId, projectId]);

  console.log('\nSuccess!');
  console.log('Use this link to configure the API key directly in n8n (zero-log):');
  console.log(`https://n8n.parris.app/projects/${projectId}/credentials/${credId}?uiContext=credentials_list`);

  await client.end();
}

main().catch(console.error);
