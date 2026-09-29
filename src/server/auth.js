import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './db.js';
import { config } from './config.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'hpi_session';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
async function verifyPassword(pw, stored) {
  const [alg, saltHex, keyHex] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const key = await scrypt(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Naive in-memory login throttle: 8 failures / 15 min per IP+username.
const failures = new Map();
const throttled = (k) => (failures.get(k)?.filter((t) => Date.now() - t < 900_000).length ?? 0) >= 8;
const noteFailure = (k) => failures.set(k, [...(failures.get(k) ?? []).filter((t) => Date.now() - t < 900_000), Date.now()]);

export async function login(req, res) {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  const key = `${req.ip}|${username.toLowerCase()}`;
  if (throttled(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  // Always run a hash comparison so timing doesn't reveal whether the user exists.
  const ok = user ? await verifyPassword(password, user.password_hash) : (await scrypt(password, 'x', 64), false);
  if (!ok) {
    noteFailure(key);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  failures.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
    .run(sha(token), user.id, Date.now() + config.sessionHours * 3_600_000);
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure: config.production, maxAge: config.sessionHours * 3_600_000, path: '/',
  });
  res.json({ user: { username: user.username, role: user.role } });
}

export function logout(req, res) {
  const t = parseCookies(req)[COOKIE];
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
}

function currentUser(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.role, s.expires_at FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha(t));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
    return null;
  }
  return row;
}

export const me = (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Not signed in.' });
  res.json({ user: { username: u.username, role: u.role } });
};

/**
 * Server-side authorization for every /api/admin route. Also blocks cross-site
 * writes: cookies are SameSite=Strict and mutating requests must carry a custom
 * header, which browsers won't send cross-origin without a CORS preflight.
 */
export function requireAdmin(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Authentication required.' });
  if (u.role !== 'admin') return res.status(403).json({ error: 'Administrator role required.' });
  if (!['GET', 'HEAD'].includes(req.method) && req.get('x-hpi-request') !== '1') {
    return res.status(403).json({ error: 'Missing request header.' });
  }
  req.user = u;
  next();
}

export async function ensureAdminUser() {
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return null;
  const generated = !config.adminPassword;
  const password = config.adminPassword || crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)')
    .run(config.adminUsername, await hashPassword(password), 'admin');
  return { username: config.adminUsername, password, generated };
}

export async function setPassword(username, password) {
  return db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(await hashPassword(password), username).changes;
}
