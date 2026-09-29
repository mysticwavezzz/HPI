import path from 'node:path';
import fs from 'node:fs';

// Minimal .env loader (no dependency): KEY=VALUE lines, existing env wins.
const envFile = path.resolve('.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
export const config = {
  port: Number(process.env.PORT) || 3000,
  production: process.env.NODE_ENV === 'production',
  dataDir,
  dbPath: path.join(dataDir, 'hpi.db'),
  uploadDir: path.join(dataDir, 'uploads'),
  sessionHours: 12,
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
};
