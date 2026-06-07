import dotenv from 'dotenv';
dotenv.config();

const cookie = process.env.N8N_COOKIE;
if (!cookie) {
  console.error('No cookie');
  process.exit(1);
}

const authPart = cookie.split(';').map(p => p.trim()).find(p => p.startsWith('n8n-auth='));
if (!authPart) {
  console.error('No n8n-auth cookie');
  process.exit(1);
}

const jwt = authPart.split('=')[1];
const payloadBase64 = jwt.split('.')[1];
if (!payloadBase64) {
  console.error('Invalid JWT format');
  process.exit(1);
}

const payloadText = Buffer.from(payloadBase64, 'base64').toString('utf-8');
const payload = JSON.parse(payloadText);
console.log('JWT Payload:', payload);
if (payload.exp) {
  const expDate = new Date(payload.exp * 1000);
  console.log('Expiration:', expDate.toLocaleString());
  console.log('Is expired?', expDate < new Date());
}
