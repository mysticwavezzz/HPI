import { Router } from 'express';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { config } from '../config.js';
import { listPeople, summaryFor, listRaces, listRecalls } from '../queries.js';
import { derive, statusBadge, marginOfError } from '../../lib/stats.js';
import { httpError } from '../images.js';

export const mediaRouter = Router();

const xml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const signed = (n) => `${n > 0 ? '+' : ''}${n.toFixed(1)}`;
const fmtDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// -------------------------------------------------------- summary card image
function avatarDataUri(person) {
  if (!person.pfp_path) return null;
  try {
    const f = path.join(config.uploadDir, path.basename(person.pfp_path));
    return `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
  } catch { return null; }
}
const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const BADGE_COLOR = { rising: '#1c6b3a', falling: '#a51c1c' };
const BADGE_GLYPH = { rising: '▲', falling: '▼', steady: '▬', stale: '▬', new: '●', edging_up: '△', edging_down: '▽' };

function cardSvg(rows, updated) {
  const W = 1920; const H = 1080; const rowH = Math.min(112, Math.floor(760 / Math.max(rows.length, 1)));
  const body = rows.map(({ p, s }, i) => {
    const y = 250 + i * rowH; const img = avatarDataUri(p); const cy = y + rowH / 2; const r = Math.min(38, rowH / 2 - 8);
    const net = s.net; const barW = Math.min(300, Math.abs(net) * 5.5);
    const color = net >= 0 ? '#184f95' : '#a51c1c';
    return `<g>
      <line x1="80" x2="${W - 80}" y1="${y}" y2="${y}" stroke="#d8d8d2"/>
      ${img ? `<image href="${img}" x="${110 - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}"/>`
        : `<circle cx="110" cy="${cy}" r="${r}" fill="#1a1a6e"/><text x="110" y="${cy + 8}" font-size="22" fill="#fff" text-anchor="middle" font-family="Arial" font-weight="700">${xml(initials(p.full_name))}</text>`}
      <text x="180" y="${cy - 4}" font-size="34" font-weight="700" fill="#0b0b0b" font-family="Arial">${xml(p.full_name)}</text>
      <text x="180" y="${cy + 28}" font-size="22" fill="#52514e" font-family="Arial">${xml(p.title)}${p.agency_code ? ` · ${xml(p.agency_code)}` : ''}</text>
      <text x="860" y="${cy + 12}" font-size="40" font-weight="700" fill="${color}" font-family="Arial">${signed(net)}</text>
      <rect x="1000" y="${cy - 14}" width="${barW}" height="28" fill="${color}"/>
      <text x="1290" y="${cy + 8}" font-size="24" fill="#0b0b0b" font-family="Arial">${s.approve.toFixed(1)}% approve · ${s.disapprove.toFixed(1)}% disapprove</text>
      <text x="1290" y="${cy + 38}" font-size="20" fill="#52514e" font-family="Arial">n=${s.n.toLocaleString('en-US')} · ±${s.moe}%</text>
      <text x="1850" y="${cy + 10}" font-size="24" font-weight="700" fill="${BADGE_COLOR[s.badge.key] ?? '#52514e'}" font-family="Arial" text-anchor="end">${BADGE_GLYPH[s.badge.key]} ${xml(s.badge.label)}</text>
    </g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="#f7f7f5"/>
    <rect width="${W}" height="14" fill="#1a1a6e"/>
    <text x="80" y="110" font-size="24" font-weight="700" letter-spacing="3" fill="#a51c1c" font-family="Arial">HARRISON POLLING INSTITUTE</text>
    <text x="80" y="176" font-size="64" font-weight="700" fill="#1a1a6e" font-family="Georgia, serif">Leadership Approval Ratings</text>
    <text x="80" y="220" font-size="24" fill="#52514e" font-family="Arial">Net approval = approve % − disapprove % · latest poll cycle, updated ${xml(updated ? fmtDate(updated) : 'n/a')}</text>
    ${body}
    <text x="80" y="${H - 40}" font-size="20" fill="#898781" font-family="Arial">MoE at 95% confidence, computed from sample size. Independent civic intelligence for Harrison County.</text>
  </svg>`;
}

mediaRouter.get('/card.png', async (req, res) => {
  const ids = String(req.query.ids ?? '').split(',').map(Number).filter(Boolean);
  let rows = listPeople().filter((p) => p.category !== 'candidate' && (!ids.length || ids.includes(p.id)))
    .map((p) => ({ p, s: summaryFor(p) })).filter((r) => r.s);
  if (!rows.length) throw httpError(404, 'No polled officials to render.');
  rows = rows.sort((a, b) => b.s.net - a.s.net).slice(0, 8);
  const updated = db.prepare('SELECT MAX(survey_end) d FROM polls').get().d;
  const png = await sharp(Buffer.from(cardSvg(rows, updated)), { density: 144 }).resize(2880, 1620).png().toBuffer();
  res.set({ 'Content-Type': 'image/png', 'Content-Disposition': 'attachment; filename="hpi-summary-card.png"' }).send(png);
});

// ---------------------------------------------------------- press releases
function latestCycle(days) {
  const max = db.prepare('SELECT MAX(survey_end) d FROM polls').get().d;
  if (!max) return { rows: [], since: null };
  const since = new Date(Date.parse(`${max}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
  const rows = [];
  for (const p of listPeople()) {
    const polls = db.prepare('SELECT * FROM polls WHERE person_id = ? ORDER BY survey_end, id').all(p.id);
    const last = polls.at(-1);
    if (!last || last.survey_end < since) continue;
    const d = derive(last); const prev = polls.length > 1 ? derive(polls.at(-2)) : null;
    rows.push({ p, last, d, prev, badge: statusBadge(d.net, prev?.net ?? null, { lastSurveyDate: last.survey_end }) });
  }
  return { rows: rows.sort((a, b) => b.d.net - a.d.net), since, max };
}

function pressRelease(outlet, days) {
  const { rows, since, max } = latestCycle(days);
  if (!rows.length) throw httpError(404, 'No poll results in that window.');
  const paper = outlet === 'independent' ? 'The Harrison Independent' : 'The Jamestown Times';
  const lead = rows[0]; const tail = rows.at(-1);
  const headline = `HPI poll: ${lead.p.full_name} leads Harrison County approval at ${signed(lead.d.net)} net`;
  const dateline = `HARRISON COUNTY — ${fmtDate(max)}`;
  const intro = `${dateline} — The Harrison Polling Institute (HPI) today released new approval ratings for ${rows.length} county officials, ` +
    `based on surveys conducted ${fmtDate(since)} through ${fmtDate(max)}. ${lead.p.full_name} (${lead.p.title}) posted the highest net approval at ${signed(lead.d.net)}, ` +
    `while ${tail.p.full_name} (${tail.p.title}) posted ${signed(tail.d.net)}.`;
  const lines = rows.map(({ p, last, d, prev, badge }) => {
    const move = prev ? ` (${signed(d.net - prev.net)} since the prior cycle; ${badge.label.toLowerCase()})` : ' (first reading)';
    return { head: `${p.full_name}, ${p.title}${p.agency_code ? ` (${p.agency_code})` : ''}`,
      body: `Net ${signed(d.net)}${move} — ${d.approve.toFixed(1)}% approve, ${d.disapprove.toFixed(1)}% disapprove, ${d.neutral.toFixed(1)}% no opinion. n=${last.sample_size.toLocaleString('en-US')}, ±${marginOfError(last.sample_size)} pts.`,
      note: last.event_note };
  });
  const method = 'Margins of error are computed at 95% confidence from each survey’s sample size (worst case, p = 0.5). Net approval is approve % minus disapprove %.';
  const md = [`# ${headline}`, `*For ${paper} · ${dateline}*`, '', intro, '', '## Results', '',
    ...lines.flatMap((l) => [`- **${l.head}** — ${l.body}${l.note ? ` _Context: ${l.note}._` : ''}`]), '',
    '## Methodology', '', method, '', '_Full data and trend charts are available from the Harrison Polling Institute._'].join('\n');
  const txt = [headline.toUpperCase(), `For ${paper} — ${dateline}`, '', intro, '', 'RESULTS',
    ...lines.map((l) => `* ${l.head}: ${l.body}${l.note ? ` Context: ${l.note}.` : ''}`), '', 'METHODOLOGY', method, '',
    'Full data and trend charts are available from the Harrison Polling Institute.'].join('\n');
  return { outlet: paper, headline, markdown: md, text: txt };
}

mediaRouter.get('/press', (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 365);
  res.json(pressRelease(req.query.outlet === 'independent' ? 'independent' : 'times', days));
});

// ------------------------------------------------------------------ export
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

mediaRouter.get('/export.json', (req, res) => {
  const polls = db.prepare('SELECT * FROM polls ORDER BY person_id, survey_end').all().map((r) => ({ ...r, ...derive(r) }));
  const dump = {
    exported_at: new Date().toISOString(),
    agencies: db.prepare('SELECT * FROM agencies').all(),
    people: db.prepare('SELECT * FROM people').all(),
    polls,
    poll_history: db.prepare('SELECT * FROM poll_history ORDER BY id').all(),
    races: listRaces(),
    recalls: [...listRecalls('active'), ...listRecalls('archived')],
  };
  res.set({ 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="hpi-backup-${new Date().toISOString().slice(0, 10)}.json"` })
    .send(JSON.stringify(dump, null, 2));
});

mediaRouter.get('/export.csv', (req, res) => {
  const cols = ['poll_id', 'person_id', 'full_name', 'handle', 'title', 'agency', 'archived', 'survey_start', 'survey_end', 'sample_size',
    'strong_approve', 'some_approve', 'some_disapprove', 'strong_disapprove', 'neutral', 'approve', 'disapprove', 'net', 'moe', 'event_note'];
  const rows = db.prepare(`SELECT po.*, pe.full_name, pe.handle, pe.title, pe.archived_at, a.code AS agency FROM polls po
    JOIN people pe ON pe.id = po.person_id LEFT JOIN agencies a ON a.id = pe.agency_id ORDER BY pe.full_name, po.survey_end`).all();
  const lines = [cols.join(',')];
  for (const r of rows) {
    const d = derive(r);
    lines.push(cols.map((c) => csvCell({ poll_id: r.id, archived: r.archived_at ? 'yes' : 'no', ...r, ...d }[c])).join(','));
  }
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="hpi-polls-${new Date().toISOString().slice(0, 10)}.csv"` })
    .send('﻿' + lines.join('\r\n'));
});
