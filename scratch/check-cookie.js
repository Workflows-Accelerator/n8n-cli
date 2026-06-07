import dotenv from 'dotenv';
dotenv.config();

const cookie = process.env.N8N_COOKIE;
console.log('N8N_COOKIE length:', cookie ? cookie.length : 'undefined');
if (cookie) {
  console.log('N8N_COOKIE preview:', cookie.substring(0, 30) + '...' + cookie.substring(cookie.length - 20));
  // Parse cookie keys
  const parts = cookie.split(';').map(p => p.trim());
  const keys = parts.map(p => p.split('=')[0]);
  console.log('Cookie keys:', keys);
}
