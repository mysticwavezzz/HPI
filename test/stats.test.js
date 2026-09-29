import test from 'node:test';
import assert from 'node:assert/strict';
import { statusBadge, netScore, derive, marginOfError, aggregate, weekStart, raceLead, shares } from '../src/lib/stats.js';
import { validatePoll } from '../src/lib/validate.js';

const NOW = '2026-09-29';
const badge = (latest, prev) => statusBadge(latest, prev, { lastSurveyDate: '2026-09-20', now: NOW });

test('net score = approve − disapprove', () => {
  assert.equal(netScore(58.3, 26.7), 31.6);
  assert.equal(derive({ strong_approve: 20, some_approve: 25, some_disapprove: 15, strong_disapprove: 25, neutral: 15, sample_size: 400 }).net, 5);
});

test('badge thresholds: rising / falling boundaries', () => {
  assert.equal(badge(13, 10).key, 'rising'); // +3.0 exactly
  assert.equal(badge(12.9, 10).key, 'edging_up'); // +2.9
  assert.equal(badge(7, 10).key, 'falling'); // −3.0 exactly
  assert.equal(badge(7.1, 10).key, 'edging_down');
});

test('badge thresholds: steady band and floating-point safety', () => {
  assert.equal(badge(11, 10).key, 'steady'); // +1.0 exactly
  assert.equal(badge(9, 10).key, 'steady');
  assert.equal(badge(11.1, 10).key, 'edging_up');
  assert.equal(badge(0.3 + 2.7, 0).key, 'rising'); // 3.0000000000000004-style drift
  assert.equal(badge(10.2, 10).key, 'steady');
});

test('badge: new, stale, and delta reporting', () => {
  assert.equal(badge(5, null).key, 'new');
  assert.equal(statusBadge(5, 5, { lastSurveyDate: '2026-05-01', now: NOW }).key, 'stale');
  assert.equal(badge(15.5, 10).delta, 5.5);
});

test('margin of error uses 1.96·√(0.25/n)', () => {
  assert.equal(marginOfError(1000), 3.1);
  assert.equal(marginOfError(400), 4.9);
  assert.throws(() => marginOfError(0));
});

test('weekly/monthly aggregation pools by n', () => {
  const p = (end, n, a) => ({ survey_start: end, survey_end: end, sample_size: n, strong_approve: a, some_approve: 0, some_disapprove: 0, strong_disapprove: 100 - a, neutral: 0, event_note: null });
  const [w] = aggregate([p('2026-09-14', 100, 40), p('2026-09-16', 300, 60)], 'weekly');
  assert.equal(w.n, 400); assert.equal(w.approve, 55); assert.equal(weekStart('2026-09-20'), '2026-09-14');
  assert.equal(aggregate([p('2026-09-14', 100, 40), p('2026-10-01', 100, 40)], 'monthly').length, 2);
});

test('race shares and lead come from actual votes only', () => {
  const c = [{ id: 1, votes: 118 }, { id: 2, votes: 78 }, { id: 3, votes: 104 }];
  assert.deepEqual(shares([118, 78, 104]), [39.3, 26, 34.7]);
  assert.deepEqual(raceLead(c), { total: 300, leader: 1, tied: false, gap_votes: 14, gap_pct: 4.7 });
  assert.deepEqual(shares([0, 0]), [null, null]); // no votes yet -> no percentages
  assert.equal(raceLead([{ id: 1, votes: 0 }, { id: 2, votes: 0 }]).leader, null);
  assert.equal(raceLead([{ id: 1, votes: 5 }, { id: 2, votes: 5 }]).tied, true);
});

test('poll validation: totals, dates, sample size', () => {
  const ok = { person_id: 1, survey_start: '2026-09-01', survey_end: '2026-09-05', sample_size: 500, strong_approve: 20, some_approve: 25, some_disapprove: 15, strong_disapprove: 25, neutral: 15 };
  assert.ok(validatePoll(ok).value);
  assert.match(validatePoll({ ...ok, neutral: 20 }).errors.join(), /total/i);
  assert.ok(validatePoll({ ...ok, neutral: 20, allow_mismatch: true }).value.total_flagged);
  assert.ok(validatePoll({ ...ok, survey_start: '2026-09-09' }).errors);
  assert.ok(validatePoll({ ...ok, sample_size: 0 }).errors);
  assert.ok(validatePoll({ ...ok, survey_end: '2026-02-30' }).errors);
});
