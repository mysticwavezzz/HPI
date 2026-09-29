import { Router } from 'express';
import multer from 'multer';
import { db, nowSql } from '../db.js';
import { requireAdmin } from '../auth.js';
import { httpError, processPfp, fetchRemoteImage, removeImages } from '../images.js';
import { listPeople, getPerson, summaryFor, listRaces, listRecalls, pollsFor } from '../queries.js';
import { derive, statusBadge } from '../../lib/stats.js';
import { validatePoll, requireString, CATEGORIES, GROUNDS, OUTCOME_BADGES, num, isIsoDate } from '../../lib/validate.js';
import { mediaRouter } from './media.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const fail = (errors, status = 422) => { throw Object.assign(new Error(errors.join(' ')), { status, expose: true, errors }); };
const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Invalid id.');
  return id;
};
const isArr = (v) => Array.isArray(v);

// ---------------------------------------------------------------- agencies
adminRouter.get('/agencies', (req, res) => res.json(db.prepare('SELECT * FROM agencies ORDER BY code').all()));
adminRouter.post('/agencies', (req, res) => {
  const errors = [];
  const code = requireString(req.body.code, 'Code', 20, errors).toUpperCase();
  const name = requireString(req.body.name, 'Name', 80, errors, { optional: true }) || code;
  if (errors.length) fail(errors);
  if (db.prepare('SELECT 1 FROM agencies WHERE code = ?').get(code)) throw httpError(409, `Agency “${code}” already exists.`);
  const { lastInsertRowid } = db.prepare('INSERT INTO agencies (code, name) VALUES (?,?)').run(code, name);
  res.status(201).json(db.prepare('SELECT * FROM agencies WHERE id = ?').get(lastInsertRowid));
});

// ------------------------------------------------------------------ people
adminRouter.get('/people', (req, res) => {
  const archived = req.query.archived === '1';
  const people = listPeople({ archived, q: String(req.query.q ?? '') }).map((p) => ({ ...p, summary: summaryFor(p) }));
  res.json(people);
});

function personFields(body) {
  const errors = [];
  const v = {
    full_name: requireString(body.full_name, 'Full name', 100, errors),
    handle: requireString(body.handle, 'Handle', 50, errors, { optional: true }),
    title: requireString(body.title, 'Government title', 120, errors),
    category: String(body.category ?? ''),
    agency_id: body.agency_id ? Number(body.agency_id) : null,
    outcome_badge: String(body.outcome_badge ?? ''),
  };
  if (!CATEGORIES.includes(v.category)) errors.push('Choose a category.');
  if (!OUTCOME_BADGES.includes(v.outcome_badge)) errors.push('Invalid outcome badge.');
  if (v.agency_id != null && !db.prepare('SELECT 1 FROM agencies WHERE id = ?').get(v.agency_id)) errors.push('Unknown agency.');
  if (errors.length) fail(errors);
  return v;
}

async function applyImage(personId, req) {
  let buf = req.file?.buffer;
  if (!buf && req.body.pfp_url?.trim()) buf = await fetchRemoteImage(req.body.pfp_url.trim());
  if (!buf) return null;
  return processPfp(buf, personId);
}

adminRouter.post('/people', upload.single('pfp'), async (req, res) => {
  const v = personFields(req.body);
  const { lastInsertRowid: id } = db.prepare(`INSERT INTO people (full_name, handle, title, agency_id, category, outcome_badge)
    VALUES (@full_name, @handle, @title, @agency_id, @category, @outcome_badge)`).run(v);
  try {
    const img = await applyImage(id, req);
    if (img) db.prepare('UPDATE people SET pfp_path = ?, thumb_path = ? WHERE id = ?').run(img.pfp_path, img.thumb_path, id);
  } catch (e) {
    db.prepare('DELETE FROM people WHERE id = ?').run(id); // don't keep a half-created record
    throw e;
  }
  res.status(201).json(getPerson(id));
});

adminRouter.put('/people/:id', upload.single('pfp'), async (req, res) => {
  const id = idParam(req);
  const existing = getPerson(id);
  if (!existing) throw httpError(404, 'Person not found.');
  const v = personFields(req.body);
  const img = await applyImage(id, req);
  db.prepare(`UPDATE people SET full_name=@full_name, handle=@handle, title=@title, agency_id=@agency_id,
    category=@category, outcome_badge=@outcome_badge, updated_at=@now WHERE id=@id`).run({ ...v, id, now: nowSql() });
  if (img) {
    db.prepare('UPDATE people SET pfp_path=?, thumb_path=? WHERE id=?').run(img.pfp_path, img.thumb_path, id);
    removeImages(existing.pfp_path, existing.thumb_path);
  } else if (req.body.remove_pfp === 'true') {
    db.prepare('UPDATE people SET pfp_path=NULL, thumb_path=NULL WHERE id=?').run(id);
    removeImages(existing.pfp_path, existing.thumb_path);
  }
  res.json(getPerson(id));
});

adminRouter.post('/people/:id/archive', (req, res) => {
  const id = idParam(req);
  const reason = requireString(req.body.reason, 'Reason', 200, [], { optional: true });
  if (!db.prepare('UPDATE people SET archived_at=?, archive_reason=? WHERE id=? AND archived_at IS NULL').run(nowSql(), reason || null, id).changes) {
    throw httpError(404, 'Active person not found.');
  }
  res.json(getPerson(id));
});
adminRouter.post('/people/:id/unarchive', (req, res) => {
  const id = idParam(req);
  if (!db.prepare('UPDATE people SET archived_at=NULL, archive_reason=NULL WHERE id=? AND archived_at IS NOT NULL').run(id).changes) {
    throw httpError(404, 'Archived person not found.');
  }
  res.json(getPerson(id));
});
// Deleting is permanent and cascades to polls, so the client must echo the full name back.
adminRouter.delete('/people/:id', (req, res) => {
  const id = idParam(req);
  const p = getPerson(id);
  if (!p) throw httpError(404, 'Person not found.');
  if (req.body?.confirm_name !== p.full_name) throw httpError(400, 'Confirmation name does not match.');
  db.transaction(() => {
    for (const poll of pollsFor(id)) logHistory(poll.id, p, req.user, 'delete', poll, null);
    db.prepare('DELETE FROM people WHERE id = ?').run(id);
  })();
  removeImages(p.pfp_path, p.thumb_path);
  res.json({ ok: true });
});

// ------------------------------------------------------------------- polls
const POLL_COLS = ['person_id', 'survey_start', 'survey_end', 'sample_size', 'strong_approve', 'some_approve',
  'some_disapprove', 'strong_disapprove', 'neutral', 'event_note', 'total_flagged'];
const snapshot = (row) => row && Object.fromEntries(POLL_COLS.map((c) => [c, row[c]]));

function logHistory(pollId, person, user, type, prior, next) {
  db.prepare(`INSERT INTO poll_history (poll_id, person_id, person_name, changed_by, change_type, prior_values, new_values)
    VALUES (?,?,?,?,?,?,?)`).run(pollId, person.id, person.full_name, user.username, type,
    prior ? JSON.stringify(snapshot(prior)) : null, next ? JSON.stringify(snapshot(next)) : null);
}

const withDerived = (row) => ({ ...row, ...derive(row) });

adminRouter.get('/polls', (req, res) => {
  const where = []; const args = [];
  if (req.query.person_id) { where.push('po.person_id = ?'); args.push(Number(req.query.person_id)); }
  const q = String(req.query.q ?? '').trim();
  if (q) { where.push('(pe.full_name LIKE ? OR po.event_note LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  const rows = db.prepare(`SELECT po.*, pe.full_name, pe.archived_at FROM polls po JOIN people pe ON pe.id = po.person_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY po.survey_end DESC, po.id DESC LIMIT 500`).all(...args);
  res.json(rows.map(withDerived));
});

// Batch: all rows validated first; nothing is written unless every row is valid.
adminRouter.post('/polls/batch', (req, res) => {
  const rows = req.body?.rows;
  if (!isArr(rows) || !rows.length) throw httpError(400, 'Add at least one row.');
  if (rows.length > 200) throw httpError(400, 'A batch can contain at most 200 rows.');
  const parsed = []; const rowErrors = {};
  rows.forEach((r, i) => {
    const out = validatePoll(r ?? {});
    if (out.errors) rowErrors[i] = out.errors;
    else if (!getPerson(out.value.person_id)) rowErrors[i] = ['Unknown official.'];
    else parsed.push(out.value);
  });
  if (Object.keys(rowErrors).length) return res.status(422).json({ error: 'Some rows need attention.', rowErrors });
  const saved = db.transaction(() => parsed.map((v) => {
    const { lastInsertRowid } = db.prepare(`INSERT INTO polls (person_id, survey_start, survey_end, sample_size, strong_approve,
      some_approve, some_disapprove, strong_disapprove, neutral, event_note, total_flagged, created_by)
      VALUES (@person_id,@survey_start,@survey_end,@sample_size,@strong_approve,@some_approve,@some_disapprove,
      @strong_disapprove,@neutral,@event_note,@total_flagged,@by)`).run({ ...v, by: req.user.username });
    const row = db.prepare('SELECT * FROM polls WHERE id = ?').get(lastInsertRowid);
    logHistory(row.id, getPerson(v.person_id), req.user, 'create', null, row);
    return row;
  }))();
  // Report the recomputed badges so the admin sees the public effect immediately.
  const badges = [...new Set(saved.map((r) => r.person_id))].map((pid) => {
    const p = getPerson(pid); const s = summaryFor(p);
    return { person_id: pid, name: p.full_name, net: s.net, badge: s.badge };
  });
  res.status(201).json({ saved: saved.length, badges });
});

adminRouter.put('/polls/:id', (req, res) => {
  const id = idParam(req);
  const prior = db.prepare('SELECT * FROM polls WHERE id = ?').get(id);
  if (!prior) throw httpError(404, 'Poll not found.');
  const out = validatePoll({ ...req.body });
  if (out.errors) fail(out.errors);
  const v = out.value;
  if (!getPerson(v.person_id)) fail(['Unknown official.']);
  db.transaction(() => {
    db.prepare(`UPDATE polls SET person_id=@person_id, survey_start=@survey_start, survey_end=@survey_end, sample_size=@sample_size,
      strong_approve=@strong_approve, some_approve=@some_approve, some_disapprove=@some_disapprove,
      strong_disapprove=@strong_disapprove, neutral=@neutral, event_note=@event_note, total_flagged=@total_flagged,
      updated_at=@now WHERE id=@id`).run({ ...v, id, now: nowSql() });
    logHistory(id, getPerson(v.person_id), req.user, 'update', prior, db.prepare('SELECT * FROM polls WHERE id = ?').get(id));
  })();
  res.json(withDerived(db.prepare('SELECT * FROM polls WHERE id = ?').get(id)));
});

adminRouter.delete('/polls/:id', (req, res) => {
  const id = idParam(req);
  const prior = db.prepare('SELECT * FROM polls WHERE id = ?').get(id);
  if (!prior) throw httpError(404, 'Poll not found.');
  db.transaction(() => {
    logHistory(id, getPerson(prior.person_id), req.user, 'delete', prior, null);
    db.prepare('DELETE FROM polls WHERE id = ?').run(id);
  })();
  res.json({ ok: true });
});

adminRouter.get('/polls/history', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const rows = db.prepare(`SELECT * FROM poll_history
    WHERE (? = '' OR person_name LIKE ? OR changed_by LIKE ? OR change_type LIKE ? OR prior_values LIKE ? OR new_values LIKE ? OR CAST(poll_id AS TEXT) = ?)
    ORDER BY id DESC LIMIT 300`).all(q, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, q);
  res.json(rows.map((r) => ({ ...r, prior_values: r.prior_values && JSON.parse(r.prior_values), new_values: r.new_values && JSON.parse(r.new_values) })));
});

// ------------------------------------------------------------------- races
const ISSUES = ['Prosecution Speed', 'Evidence Standards', 'Public Safety Cooperation', 'Ethics'];

const count = (v) => (v === '' || v == null ? 0 : Number(v));
const isCount = (n) => Number.isInteger(n) && n >= 0 && n <= 10_000_000;

// Races hold actual vote COUNTS only. Percentages are derived in src/lib/stats.js; nothing is projected.
function raceInput(body) {
  const errors = [];
  const v = {
    title: requireString(body.title, 'Title', 150, errors),
    turnout_min: body.turnout_min === '' || body.turnout_min == null ? null : num(body.turnout_min),
    turnout_max: body.turnout_max === '' || body.turnout_max == null ? null : num(body.turnout_max),
  };
  for (const k of ['turnout_min', 'turnout_max']) {
    if (v[k] != null && (!Number.isInteger(v[k]) || v[k] < 0)) errors.push('Expected turnout must be a whole number ≥ 0.');
  }
  if (v.turnout_min != null && v.turnout_max != null && v.turnout_min > v.turnout_max) errors.push('Turnout minimum exceeds maximum.');
  const candidates = isArr(body.candidates) ? body.candidates.map((c) => ({ person_id: Number(c.person_id), votes: count(c.votes) })) : [];
  if (candidates.length < 2) errors.push('A race needs at least two candidates.');
  if (new Set(candidates.map((c) => c.person_id)).size !== candidates.length) errors.push('Each candidate can only appear once.');
  for (const c of candidates) {
    if (!getPerson(c.person_id)) errors.push('Unknown candidate.');
    if (!isCount(c.votes)) errors.push('Votes must be whole numbers (0 or more).');
  }
  // priorities: { [person_id]: { [issue]: count } } — optional counts of supporters naming each issue.
  const priorities = [];
  for (const [pid, issues] of Object.entries(body.priorities ?? {})) {
    if (!candidates.some((c) => c.person_id === Number(pid))) continue;
    const vals = ISSUES.map((i) => count(issues?.[i]));
    if (vals.every((x) => x === 0)) continue;
    if (!vals.every(isCount)) { errors.push('Issue counts must be whole numbers (0 or more).'); continue; }
    ISSUES.forEach((issue, i) => priorities.push({ person_id: Number(pid), issue, votes: vals[i] }));
  }
  if (errors.length) fail([...new Set(errors)]);
  return { v, candidates, priorities };
}

function saveRace(id, { v, candidates, priorities }) {
  db.transaction(() => {
    if (id) db.prepare('UPDATE races SET title=@title, turnout_min=@turnout_min, turnout_max=@turnout_max, updated_at=@now WHERE id=@id').run({ ...v, id, now: nowSql() });
    else id = db.prepare('INSERT INTO races (title, turnout_min, turnout_max) VALUES (@title,@turnout_min,@turnout_max)').run(v).lastInsertRowid;
    db.prepare('DELETE FROM race_candidates WHERE race_id=?').run(id);
    db.prepare('DELETE FROM race_priorities WHERE race_id=?').run(id);
    for (const c of candidates) db.prepare('INSERT INTO race_candidates (race_id, person_id, votes, vote_share) VALUES (?,?,?,0)').run(id, c.person_id, c.votes);
    for (const p of priorities) db.prepare('INSERT INTO race_priorities (race_id, person_id, issue, votes, pct) VALUES (?,?,?,?,0)').run(id, p.person_id, p.issue, p.votes);
  })();
  return id;
}

adminRouter.get('/races', (req, res) => res.json({ races: listRaces(), issues: ISSUES }));
adminRouter.post('/races', (req, res) => {
  const id = saveRace(null, raceInput(req.body));
  res.status(201).json(listRaces().find((r) => r.id === id));
});
adminRouter.put('/races/:id', (req, res) => {
  const id = idParam(req);
  if (!db.prepare('SELECT 1 FROM races WHERE id=?').get(id)) throw httpError(404, 'Race not found.');
  saveRace(id, raceInput(req.body));
  res.json(listRaces().find((r) => r.id === id));
});
adminRouter.delete('/races/:id', (req, res) => {
  if (!db.prepare('DELETE FROM races WHERE id=?').run(idParam(req)).changes) throw httpError(404, 'Race not found.');
  res.json({ ok: true });
});
// Concluding marks the winner “Succeeded”; the person stays on the roster until an admin archives them.
adminRouter.post('/races/:id/conclude', (req, res) => {
  const id = idParam(req);
  const winner = Number(req.body?.winner_person_id);
  if (!db.prepare('SELECT 1 FROM race_candidates WHERE race_id=? AND person_id=?').get(id, winner)) throw httpError(400, 'Winner must be a candidate in this race.');
  db.transaction(() => {
    db.prepare("UPDATE races SET status='concluded', winner_person_id=?, updated_at=? WHERE id=?").run(winner, nowSql(), id);
    db.prepare("UPDATE people SET outcome_badge='succeeded' WHERE id=?").run(winner);
  })();
  res.json(listRaces().find((r) => r.id === id));
});
adminRouter.post('/races/:id/reopen', (req, res) => {
  const id = idParam(req);
  db.prepare("UPDATE races SET status='active', winner_person_id=NULL WHERE id=?").run(id);
  res.json(listRaces().find((r) => r.id === id));
});

// ----------------------------------------------------------------- recalls
function recallInput(body) {
  const errors = [];
  const v = {
    person_id: Number(body.person_id),
    grounds: String(body.grounds ?? ''),
    threshold: num(body.threshold),
    milestone: body.milestone === '' || body.milestone == null ? null : num(body.milestone),
    verified: num(body.verified ?? 0),
    filed_on: body.filed_on || null,
    notes: requireString(body.notes, 'Notes', 500, errors, { optional: true }) || null,
  };
  if (!getPerson(v.person_id)) errors.push('Select the target official.');
  if (!GROUNDS.includes(v.grounds)) errors.push(`Grounds must be one of: ${GROUNDS.join(', ')}.`);
  if (!Number.isInteger(v.threshold) || v.threshold < 1) errors.push('Signature threshold must be a positive whole number.');
  if (!Number.isInteger(v.verified) || v.verified < 0) errors.push('Verified signatures must be a whole number ≥ 0.');
  if (v.milestone != null && (!Number.isInteger(v.milestone) || v.milestone < 1 || v.milestone > v.threshold)) errors.push('Milestone must be between 1 and the threshold.');
  if (v.filed_on && !isIsoDate(v.filed_on)) errors.push('Filed date is invalid.');
  if (errors.length) fail(errors);
  return v;
}
const recallById = (id) => [...listRecalls('active'), ...listRecalls('archived')].find((r) => r.id === id);

adminRouter.get('/recalls', (req, res) => res.json({ active: listRecalls('active'), archived: listRecalls('archived'), grounds: GROUNDS }));
adminRouter.post('/recalls', (req, res) => {
  const { lastInsertRowid } = db.prepare(`INSERT INTO recalls (person_id, grounds, threshold, milestone, verified, filed_on, notes)
    VALUES (@person_id,@grounds,@threshold,@milestone,@verified,@filed_on,@notes)`).run(recallInput(req.body));
  res.status(201).json(recallById(lastInsertRowid));
});
adminRouter.put('/recalls/:id', (req, res) => {
  const id = idParam(req);
  if (!db.prepare('UPDATE recalls SET person_id=@person_id, grounds=@grounds, threshold=@threshold, milestone=@milestone, verified=@verified, filed_on=@filed_on, notes=@notes, updated_at=@now WHERE id=@id')
    .run({ ...recallInput(req.body), id, now: nowSql() }).changes) throw httpError(404, 'Recall not found.');
  res.json(recallById(id));
});
adminRouter.delete('/recalls/:id', (req, res) => {
  if (!db.prepare('DELETE FROM recalls WHERE id=?').run(idParam(req)).changes) throw httpError(404, 'Recall not found.');
  res.json({ ok: true });
});
// Move a concluded recall into the referendum archive. A "Recalled" outcome also flags the official.
adminRouter.post('/recalls/:id/archive', (req, res) => {
  const id = idParam(req);
  const outcome = String(req.body?.outcome ?? '');
  if (!['Recalled', 'Retained', 'Failed to qualify'].includes(outcome)) throw httpError(400, 'Choose an outcome.');
  const yes = req.body?.votes_yes === '' || req.body?.votes_yes == null ? null : Number(req.body.votes_yes);
  const no = req.body?.votes_no === '' || req.body?.votes_no == null ? null : Number(req.body.votes_no);
  if ([yes, no].some((x) => x != null && !isCount(x))) throw httpError(422, 'Vote counts must be whole numbers (0 or more).');
  if ((yes == null) !== (no == null)) throw httpError(422, 'Enter both the Yes and No vote counts, or neither.');
  const concluded = req.body?.concluded_on || new Date().toISOString().slice(0, 10);
  if (!isIsoDate(concluded)) throw httpError(422, 'Concluded date is invalid.');
  const r = db.prepare("SELECT * FROM recalls WHERE id=? AND status='active'").get(id);
  if (!r) throw httpError(404, 'Active recall not found.');
  db.transaction(() => {
    db.prepare("UPDATE recalls SET status='archived', outcome=?, votes_yes=?, votes_no=?, concluded_on=?, updated_at=? WHERE id=?").run(outcome, yes, no, concluded, nowSql(), id);
    if (outcome === 'Recalled') db.prepare("UPDATE people SET outcome_badge='recalled' WHERE id=?").run(r.person_id);
  })();
  res.json(recallById(id));
});

adminRouter.use('/media', mediaRouter);
