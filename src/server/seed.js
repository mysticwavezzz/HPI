import { fileURLToPath } from 'node:url';
import { db } from './db.js';

// Deterministic PRNG so every fresh install looks identical.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const r1 = (x) => Math.round(x * 10) / 10;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const AGENCIES = [['HCDAO', "Harrison County District Attorney's Office"], ['JPD', 'Jamestown Police Department'], ['HCWM', 'Harrison County Waste Management'],
  ['Council', 'Harrison County Council'], ['Westpoint', 'Westpoint'], ['HCFD', 'Harrison County Fire Department'], ['HCSO', "Harrison County Sheriff's Office"],
  ['Executive', 'Office of the County Executive'], ['HCM', 'Harrison County Militia'], ['HCTA', 'Harrison County Transportation Authority'], ['HCEC', 'Harrison County Electoral Commission']];

// a0/a1: approve trend start/end (before the final cycle); d0/d1 disapprove; dnet: net change in the final cycle.
// NOTE: names other than the four DA candidates and "Francis" are fictional placeholders.
const OFFICIALS = [
  { name: 'Harlan Voss', handle: '@HarlanVoss', title: 'County Executive', ag: 'Executive', cat: 'constitutional', a0: 51, a1: 47, d0: 36, d1: 42, dnet: -5.2,
    events: { '2026-09-13': 'Sept 11: Red Front Executive Order', '2026-06-14': 'June 12: FY27 budget signed' } },
  { name: 'Francis Whitcombe', handle: '@FrancisDA', title: 'District Attorney', ag: 'HCDAO', cat: 'constitutional', a0: 44, a1: 33, d0: 42, d1: 55, dnet: -14,
    badge: 'recalled', events: { '2026-09-27': 'Sept 27: Francis Recalled 64.6%', '2026-08-16': 'Aug 14: Recall petition certified' } },
  { name: 'Dale Ridgeway', handle: '@SheriffRidgeway', title: 'Sheriff', ag: 'HCSO', cat: 'constitutional', a0: 55, a1: 58, d0: 30, d1: 27, dnet: 0.6 },
  { name: 'Imogen Pryce', handle: '@CouncilorPryce', title: 'County Councilor', ag: 'Council', cat: 'constitutional', a0: 46, a1: 49, d0: 38, d1: 35, dnet: 3.4 },
  { name: 'Tobias Wren', handle: '@CouncilorWren', title: 'County Councilor', ag: 'Council', cat: 'constitutional', a0: 41, a1: 40, d0: 41, d1: 43, dnet: -1.8 },
  { name: 'Ansel Briggs', handle: '@ChiefBriggs', title: 'Jamestown Police Chief', ag: 'JPD', cat: 'department', a0: 57, a1: 61, d0: 29, d1: 25, dnet: 0.4 },
  { name: 'Priya Nandakumar', handle: '@HCWM_Director', title: 'Waste Management Director', ag: 'HCWM', cat: 'department', a0: 39, a1: 34, d0: 40, d1: 46, dnet: -3.6 },
  { name: 'Rosa Delacroix', handle: '@FireChiefRosa', title: 'Fire Chief', ag: 'HCFD', cat: 'department', a0: 66, a1: 67, d0: 20, d1: 19, dnet: 0.2 },
  { name: 'Everett Thorne', handle: '@ColThorne', title: 'Militia Colonel', ag: 'HCM', cat: 'department', a0: 43, a1: 42, d0: 37, d1: 38, dnet: 3.1,
    events: { '2026-09-13': 'Sept 12: Militia readiness drill' } },
  { name: 'Lena Marchetti', handle: '@HCTA_Chief', title: 'Transportation Authority Chief', ag: 'HCTA', cat: 'department', a0: 48, a1: 50, d0: 32, d1: 31, dnet: 1.9 },
  { name: 'Owen Fairchild', handle: '@ElectoralAdmin', title: 'Electoral Commission Administrator', ag: 'HCEC', cat: 'department', a0: 52, a1: 53, d0: 28, d1: 28, dnet: 0.0 },
];
const CANDIDATES = [
  { name: 'M_ysticWavezzz', handle: '@M_ysticWavezzz', title: 'First Assistant District Attorney', ag: 'HCDAO', votes: 118, pri: [102, 90, 63, 45] },
  { name: 'Dannlabs', handle: '@Dannlabs', title: 'Head of Criminal Division', ag: 'HCDAO', votes: 78, pri: [17, 32, 16, 13] },
  { name: 'Xolaaz', handle: '@Xolaaz', title: 'Westpoint Prosecutor', ag: 'Westpoint', votes: 57, pri: [10, 14, 22, 11] },
  { name: 'Ello8m', handle: '@Ello8m', title: 'Defense Counsel', ag: 'Westpoint', votes: 47, pri: [7, 13, 8, 19] },
];

function buildPolls(o, idx) {
  const rand = rng(1000 + idx * 97);
  const weeks = 29; const first = '2026-03-02'; const polls = [];
  const finalIdx = weeks - 1;
  const lastApprove = o.a1 + (o.dnet ?? 0) / 2; const lastDis = o.d1 - (o.dnet ?? 0) / 2;
  for (let i = 0; i < weeks; i++) {
    const t = i / (finalIdx - 1);
    let a; let d;
    if (i === finalIdx) { a = lastApprove; d = lastDis; } else {
      a = o.a0 + (o.a1 - o.a0) * Math.min(t, 1) + (rand() - 0.5) * 1.2;
      d = o.d0 + (o.d1 - o.d0) * Math.min(t, 1) + (rand() - 0.5) * 1.2;
    }
    const start = addDays(first, i * 7); const end = addDays(start, 4);
    const n = Math.round(420 + rand() * 480);
    a = r1(a); d = r1(d);
    const sa = r1(a * (0.42 + rand() * 0.1)); const sd = r1(d * (0.5 + rand() * 0.12));
    const row = { survey_start: start, survey_end: end, sample_size: n, strong_approve: sa, some_approve: r1(a - sa),
      some_disapprove: r1(d - sd), strong_disapprove: sd, neutral: r1(100 - a - d), event_note: null };
    polls.push(row);
  }
  // Snap events to the poll whose window contains the event date (or add a dedicated poll for late dates).
  for (const [date, note] of Object.entries(o.events ?? {})) {
    const hit = polls.find((p) => p.survey_start <= date && date <= p.survey_end) ?? polls.filter((p) => p.survey_end <= date).at(-1);
    if (date > polls.at(-1).survey_end) {
      // Special post-event poll (e.g., Francis after the recall vote).
      polls.push({ ...polls.at(-1), survey_start: addDays(date, -3), survey_end: date, event_note: note });
      // Post-event poll: approval slides a further 4 points into disapproval.
      const p = polls.at(-1);
      p.some_approve = r1(Math.max(p.some_approve - 4, 0));
      p.some_disapprove = r1(p.some_disapprove + 4);
    } else hit.event_note = note;
  }
  return polls;
}

export function seedIfEmpty() {
  if (db.prepare('SELECT 1 FROM people LIMIT 1').get()) return false;
  seed();
  console.log('Seeded demo data.');
  return true;
}

export function seed() {
  db.transaction(() => {
    const ag = {};
    for (const [code, name] of AGENCIES) ag[code] = db.prepare('INSERT INTO agencies (code, name) VALUES (?,?)').run(code, name).lastInsertRowid;
    const insPerson = db.prepare(`INSERT INTO people (full_name, handle, title, agency_id, category, outcome_badge, archived_at, archive_reason)
      VALUES (?,?,?,?,?,?,?,?)`);
    const insPoll = db.prepare(`INSERT INTO polls (person_id, survey_start, survey_end, sample_size, strong_approve, some_approve,
      some_disapprove, strong_disapprove, neutral, event_note, total_flagged, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,0,'seed')`);
    const ids = {};
    OFFICIALS.forEach((o, idx) => {
      const id = insPerson.run(o.name, o.handle, o.title, ag[o.ag], o.cat, o.badge ?? '', null, null).lastInsertRowid;
      ids[o.name] = id;
      for (const p of buildPolls(o, idx)) {
        insPoll.run(id, p.survey_start, p.survey_end, p.sample_size, p.strong_approve, p.some_approve, p.some_disapprove, p.strong_disapprove, p.neutral, p.event_note);
      }
    });
    // Archived, still searchable: a councilor recalled earlier this year.
    ids.Pike = insPerson.run('Aldous Pike', '@CouncilorPike', 'County Councilor', ag.Council, 'constitutional', 'recalled', '2026-06-01 00:00:00', 'Recalled May 18, 2026').lastInsertRowid;
    for (const c of CANDIDATES) ids[c.name] = insPerson.run(c.name, c.handle, c.title, ag[c.ag], 'candidate', '', null, null).lastInsertRowid;

    const race = db.prepare('INSERT INTO races (title, turnout_min, turnout_max) VALUES (?,?,?)').run('2026 District Attorney Special Election', 250, 300).lastInsertRowid;
    const issues = ['Prosecution Speed', 'Evidence Standards', 'Public Safety Cooperation', 'Ethics'];
    for (const c of CANDIDATES) {
      db.prepare('INSERT INTO race_candidates (race_id, person_id, votes) VALUES (?,?,?)').run(race, ids[c.name], c.votes);
      issues.forEach((issue, i) => db.prepare('INSERT INTO race_priorities (race_id, person_id, issue, votes) VALUES (?,?,?,?)').run(race, ids[c.name], issue, c.pri[i]));
    }
    const insRecall = db.prepare(`INSERT INTO recalls (person_id, grounds, threshold, milestone, verified, filed_on, status, outcome, votes_yes, votes_no, concluded_on, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    insRecall.run(ids['Dale Ridgeway'], 'Neglect', 150, 100, 97, '2026-08-20', 'active', null, null, null, null, 'Petition cites jail-inspection lapses.');
    insRecall.run(ids['Priya Nandakumar'], 'Corruption', 120, 60, 34, '2026-09-08', 'active', null, null, null, null, 'Petition cites the 2025 hauling contract.');
    insRecall.run(ids['Francis Whitcombe'], 'Corruption', 140, 140, 152, '2026-07-30', 'archived', 'Recalled', 155, 85, '2026-09-27', 'Referendum passed; DA special election called.');
    insRecall.run(ids.Pike, 'Neglect', 100, 100, 118, '2026-04-02', 'archived', 'Recalled', 176, 127, '2026-05-18', null);
  })();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--reset')) {
    db.transaction(() => {
      for (const t of ['recalls', 'race_priorities', 'race_candidates', 'races', 'poll_history', 'polls', 'people', 'agencies']) db.prepare(`DELETE FROM ${t}`).run();
    })();
    seed();
    console.log('Database reset and reseeded (users kept).');
  } else console.log(seedIfEmpty() ? 'Done.' : 'Database already has data. Use --reset to wipe and reseed.');
}
