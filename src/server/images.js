import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';

const MAX_BYTES = 5 * 1024 * 1024;
const PFP = 512;

fs.mkdirSync(path.join(config.uploadDir), { recursive: true });

const isPrivateIp = (ip) => {
  if (net.isIPv6(ip)) return ip === '::1' || /^(fc|fd|fe80)/i.test(ip) || ip.startsWith('::ffff:127.') || ip === '::';
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
};

/** Download an external image with SSRF, size, time and redirect guards. */
export async function fetchRemoteImage(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw httpError(400, 'Image URL is not valid.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw httpError(400, 'Image URL must be http(s).');
  const addrs = await dns.lookup(url.hostname, { all: true }).catch(() => { throw httpError(400, 'Image host could not be resolved.'); });
  if (addrs.some((a) => isPrivateIp(a.address))) throw httpError(400, 'Image host is not allowed.');
  let res;
  try {
    res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  } catch { throw httpError(400, 'Could not download the image (timeout, redirect or network error).'); }
  if (!res.ok) throw httpError(400, `Image download failed (HTTP ${res.status}).`);
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_BYTES) throw httpError(400, 'Image is larger than 5 MB.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw httpError(400, 'Image is larger than 5 MB.');
  return buf;
}

/**
 * Produce a 512px circular PNG (transparent corners) and a 240x300 portrait
 * thumbnail (JPEG) from any decodable image. Returns public URL paths.
 */
export async function processPfp(buffer, personId) {
  let base;
  try {
    base = sharp(buffer, { failOn: 'error', limitInputPixels: 40_000_000 }).rotate();
    await base.metadata();
  } catch { throw httpError(400, 'File is not a supported image.'); }
  const stamp = Date.now();
  const circleName = `pfp-${personId}-${stamp}.png`;
  const thumbName = `thumb-${personId}-${stamp}.jpg`;
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PFP}" height="${PFP}"><circle cx="${PFP / 2}" cy="${PFP / 2}" r="${PFP / 2}"/></svg>`);
  await base.clone().resize(PFP, PFP, { fit: 'cover', position: 'attention' })
    .composite([{ input: mask, blend: 'dest-in' }]).png({ compressionLevel: 9 })
    .toFile(path.join(config.uploadDir, circleName));
  await base.clone().resize(240, 300, { fit: 'cover', position: 'attention' }).jpeg({ quality: 82 })
    .toFile(path.join(config.uploadDir, thumbName));
  return { pfp_path: `/uploads/${circleName}`, thumb_path: `/uploads/${thumbName}` };
}

export function removeImages(...paths) {
  for (const p of paths.filter(Boolean)) fs.rm(path.join(config.uploadDir, path.basename(p)), { force: true }, () => {});
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}
