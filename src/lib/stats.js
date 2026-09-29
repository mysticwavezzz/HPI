/**
 * HPI derived-statistics module — the ONLY place where net score, margin of
 * error, status badges and interval aggregation are computed. Nothing derived
 * is ever stored in the database or entered by hand.
 */

/** z-score for a 95% confidence level. */
export const Z_95 = 1.96;

/** Badge thresholds, in net-rating points between the last two poll cycles. */
export const THRESHOLDS = Object.freeze({
  rise: 3.0, // Δ >= +3.0  -> Rising
  fall: 3.0, // Δ <= -3.0  -> Falling
  steady: 1.0, // |Δ| <= 1.0 -> Steady
  staleDays: 90, // last poll older than this -> Stale
});

export const round1 = (x) => Math.round((x + Number.EPSILON) * 10) / 10;

/**
 * Margin of error (percentage points) at 95% confidence, worst case p = 0.5:
 *     MoE = z * sqrt(p(1-p) / n) * 100 = 1.96 * sqrt(0.25 / n) * 100
 * No finite-population correction is applied. Rounded to 0.1.
 */
export function marginOfError(n) {
  if (!Number.isFinite(n) || n <= 0) throw new RangeError('Sample size must be a positive number');
  return round1(Z_95 * Math.sqrt(0.25 / n) * 100);
}

/** Sum of the five response buckets. */
export function totalPct(p) {
  return round1(p.strong_approve + p.some_approve + p.some_disapprove + p.strong_disapprove + p.neutral);
}

/** Net approval = approve% − disapprove%. */
export function netScore(approve, disapprove) {
  return round1(approve - disapprove);
}

/** Derive display values for one raw poll row. */
export function derive(poll) {
  const approve = round1(poll.strong_approve + poll.some_approve);
  const disapprove = round1(poll.some_disapprove + poll.strong_disapprove);
  return {
    approve,
    disapprove,
    neutral: round1(poll.neutral),
    net: netScore(approve, disapprove),
    moe: marginOfError(poll.sample_size),
    total: totalPct(poll),
  };
}

const DAY_MS = 86_400_000;
const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY_MS;

/**
 * Status badge from the net-rating change since the previous poll cycle.
 *   Δ >= +3.0            Rising      🟢 ▲
 *   Δ <= −3.0            Falling     🔴 ▼
 *   |Δ| <= 1.0           Steady      ⚪ ▬
 *   1.0 < |Δ| < 3.0      Edging Up / Edging Down  (neutral gray, hollow arrow) — the
 *                        documented "in-between" treatment
 *   no previous poll     New
 *   last poll > 90 days  Stale (overrides the above)
 * Non-color cues: every badge has an icon glyph and a text label.
 */
export function statusBadge(latestNet, previousNet, opts = {}) {
  const { lastSurveyDate, now = new Date().toISOString().slice(0, 10) } = opts;
  if (lastSurveyDate && daysBetween(lastSurveyDate, now) > THRESHOLDS.staleDays) {
    return { key: 'stale', label: 'Stale', icon: '⚪ ▬', delta: null };
  }
  if (previousNet == null) return { key: 'new', label: 'New', icon: '⚪ ●', delta: null };
  const delta = round1(latestNet - previousNet);
  if (delta >= THRESHOLDS.rise) return { key: 'rising', label: 'Rising', icon: '🟢 ▲', delta };
  if (delta <= -THRESHOLDS.fall) return { key: 'falling', label: 'Falling', icon: '🔴 ▼', delta };
  if (Math.abs(delta) <= THRESHOLDS.steady) return { key: 'steady', label: 'Steady', icon: '⚪ ▬', delta };
  return delta > 0
    ? { key: 'edging_up', label: 'Edging Up', icon: '⚪ △', delta }
    : { key: 'edging_down', label: 'Edging Down', icon: '⚪ ▽', delta };
}

/** Monday (ISO week start) of a YYYY-MM-DD date. */
export function weekStart(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Collapse raw polls (sorted by survey_end) into weekly or monthly buckets.
 * Percentages are sample-size weighted; n is summed; MoE is recomputed from the
 * pooled n; the date range spans the bucket; event notes are carried along.
 */
export function aggregate(polls, interval) {
  const keyOf = interval === 'monthly' ? (d) => d.slice(0, 7) : weekStart;
  const buckets = new Map();
  for (const p of polls) {
    const k = keyOf(p.survey_end);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  }
  return [...buckets.entries()].map(([key, rows]) => {
    const n = rows.reduce((s, r) => s + r.sample_size, 0);
    const w = (f) => rows.reduce((s, r) => s + f(r) * r.sample_size, 0) / n;
    const approve = round1(w((r) => r.strong_approve + r.some_approve));
    const disapprove = round1(w((r) => r.some_disapprove + r.strong_disapprove));
    return {
      key,
      n,
      approve,
      disapprove,
      neutral: round1(w((r) => r.neutral)),
      net: netScore(approve, disapprove),
      moe: marginOfError(n),
      start: rows.reduce((m, r) => (r.survey_start < m ? r.survey_start : m), rows[0].survey_start),
      end: rows.reduce((m, r) => (r.survey_end > m ? r.survey_end : m), rows[0].survey_end),
      events: rows.filter((r) => r.event_note).map((r) => ({ date: r.survey_end, note: r.event_note })),
    };
  });
}

/** Percentage share of each count within its group; null for everyone while the group total is 0. */
export function shares(counts) {
  const total = counts.reduce((t, c) => t + c, 0);
  return counts.map((c) => (total > 0 ? round1((c / total) * 100) : null));
}

/**
 * Race standings from ACTUAL vote counts (no projections). Percentages, the
 * leader and the lead margin are all derived here; before any votes are
 * reported every share is null and there is no leader.
 */
export function raceLead(candidates) {
  const total = candidates.reduce((t, c) => t + c.votes, 0);
  const sorted = [...candidates].sort((a, b) => b.votes - a.votes);
  if (total === 0 || sorted.length < 2) return { total, leader: null, tied: false, gap_votes: 0, gap_pct: null };
  const gap = sorted[0].votes - sorted[1].votes;
  return { total, leader: gap > 0 ? sorted[0].id : null, tied: gap === 0, gap_votes: gap, gap_pct: round1((gap / total) * 100) };
}
