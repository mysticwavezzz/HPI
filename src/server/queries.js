import { db } from './db.js';
import { derive, statusBadge, aggregate, raceLead, shares, round1 } from '../lib/stats.js';

const PERSON_COLS = `p.id, p.full_name, p.handle, p.title, p.category, p.pfp_path, p.thumb_path, p.outcome_badge,
  p.archived_at, p.archive_reason, p.agency_id, a.code AS agency_code, a.name AS agency_name`;
const PERSON_FROM = 'FROM people p LEFT JOIN agencies a ON a.id = p.agency_id';

export const getPerson = (id) => db.prepare(`SELECT ${PERSON_COLS} ${PERSON_FROM} WHERE p.id = ?`).get(id);

export function listPeople({ archived = false, q = '' } = {}) {
  const like = `%${q.trim()}%`;
  return db.prepare(`SELECT ${PERSON_COLS} ${PERSON_FROM}
    WHERE (p.archived_at IS NOT NULL) = ? AND (? = '%%' OR p.full_name LIKE ? OR p.handle LIKE ? OR p.title LIKE ? OR a.code LIKE ?)
    ORDER BY p.category, p.full_name`).all(archived ? 1 : 0, like, like, like, like, like);
}

export const pollsFor = (personId) =>
  db.prepare('SELECT * FROM polls WHERE person_id = ? ORDER BY survey_end, id').all(personId);

/** Latest poll + previous poll → derived numbers and badge for a person, or null when never polled. */
export function summaryFor(person) {
  const rows = pollsFor(person.id);
  if (!rows.length) return null;
  const last = rows.at(-1);
  const d = derive(last);
  const prev = rows.length > 1 ? derive(rows.at(-2)) : null;
  return {
    ...d,
    n: last.sample_size,
    survey_start: last.survey_start,
    survey_end: last.survey_end,
    polls_count: rows.length,
    badge: statusBadge(d.net, prev?.net ?? null, { lastSurveyDate: last.survey_end }),
  };
}

export const trendFor = (personId, interval) =>
  aggregate(pollsFor(personId), interval === 'monthly' ? 'monthly' : 'weekly');

export function raceDetail(race) {
  const rows = db.prepare(`SELECT rc.votes, ${PERSON_COLS} FROM race_candidates rc
    JOIN people p ON p.id = rc.person_id LEFT JOIN agencies a ON a.id = p.agency_id
    WHERE rc.race_id = ? ORDER BY rc.votes DESC, p.full_name`).all(race.id);
  const pcts = shares(rows.map((c) => c.votes));
  const candidates = rows.map((c, i) => ({ ...c, vote_share: pcts[i] }));
  // Issue priorities are stored as counts; each candidate's supporter group is converted to percentages here.
  const raw = db.prepare('SELECT person_id, issue, votes FROM race_priorities WHERE race_id = ? ORDER BY rowid').all(race.id);
  const priorities = raw.map((r) => {
    const group = raw.filter((x) => x.person_id === r.person_id);
    return { person_id: r.person_id, issue: r.issue, count: r.votes, pct: shares(group.map((x) => x.votes))[group.indexOf(r)] };
  });
  return { ...race, candidates, priorities, lead: raceLead(candidates) };
}

export const listRaces = () => db.prepare('SELECT * FROM races ORDER BY status, id DESC').all().map(raceDetail);

export const listRecalls = (status) => db.prepare(`SELECT r.*, ${PERSON_COLS} ${PERSON_FROM.replace('FROM people p', 'FROM recalls r JOIN people p ON p.id = r.person_id')}
  WHERE r.status = ? ORDER BY COALESCE(r.concluded_on, r.filed_on) DESC, r.id DESC`).all(status)
  .map(({ id, person_id, grounds, threshold, milestone, verified, filed_on, outcome, concluded_on, notes, status: st, votes_yes, votes_no, ...person }) => ({
    id, person_id, grounds, threshold, milestone, verified, filed_on, outcome, concluded_on, notes, status: st, votes_yes, votes_no,
    result_pct: votes_yes != null && votes_no != null && votes_yes + votes_no > 0 ? round1((votes_yes / (votes_yes + votes_no)) * 100) : null,
    progress_pct: Math.min(100, Math.round((verified / threshold) * 1000) / 10),
    person,
  }));
