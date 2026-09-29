import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db } from './db.js';
import { login, logout, me, ensureAdminUser } from './auth.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';
import { seedIfEmpty } from './seed.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.production ? 1 : false);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  });
  next();
});
app.use(express.json({ limit: '256kb' }));

app.get('/healthz', (req, res) => { db.prepare('SELECT 1').get(); res.send('ok'); });
app.post('/api/auth/login', login);
app.post('/api/auth/logout', logout);
app.get('/api/auth/me', me);
app.use('/api/public', publicRouter);
app.use('/api/admin', adminRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use('/vendor/chart.js', express.static(path.join(root, 'node_modules/chart.js/dist/chart.umd.js')));
app.use('/shared/stats.js', express.static(path.join(root, 'src/lib/stats.js')));
app.use('/uploads', express.static(config.uploadDir, { maxAge: '7d', immutable: true }));
app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));

// Central error handler: expose only deliberate messages, log the rest.
app.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON.' });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Image is larger than 5 MB.' });
  const status = err.status || (err.code?.startsWith?.('SQLITE_CONSTRAINT') ? 409 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: err.expose || status < 500 ? err.message : 'Something went wrong. Please try again.',
    ...(err.errors ? { errors: err.errors } : {}),
  });
});

const creds = await ensureAdminUser();
if (creds) {
  console.log(`\n  Admin account created → username: ${creds.username}  password: ${creds.password}${creds.generated ? '  (generated — change it via `npm run passwd`)' : ''}\n`);
}
if (process.env.SEED_DEMO !== 'false') seedIfEmpty();
const server = app.listen(config.port, '0.0.0.0', () => console.log(`HPI running at http://localhost:${config.port}  (admin: /admin/)`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
