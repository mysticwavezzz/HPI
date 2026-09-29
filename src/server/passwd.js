// Usage: npm run passwd -- <username> <new-password>
import { db } from './db.js';
import { setPassword } from './auth.js';

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 8) {
  console.error('Usage: npm run passwd -- <username> <new-password (min 8 chars)>');
  process.exit(1);
}
console.log((await setPassword(username, password)) ? 'Password updated.' : 'No such user.');
db.close();
