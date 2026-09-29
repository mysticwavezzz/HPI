/** Input validation helpers. Each returns { value } or { errors: string[] }. */
import { totalPct } from './stats.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (s) => typeof s === 'string' && ISO.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) &&
  new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export const num = (v) => (v === '' || v == null ? NaN : Number(v));
const PCT_FIELDS = ['strong_approve', 'some_approve', 'some_disapprove', 'strong_disapprove', 'neutral'];
const PCT_LABELS = {
  strong_approve: 'Strongly Approve', some_approve: 'Somewhat Approve',
  some_disapprove: 'Somewhat Disapprove', strong_disapprove: 'Strongly Disapprove', neutral: 'No Opinion/Neutral',
};
export const MAX_SAMPLE = 100_000;

/** Validate one poll row. A total off by more than 0.5 points is rejected unless allow_mismatch is set. */
export function validatePoll(input) {
  const errors = [];
  const v = { person_id: Number(input.person_id), event_note: String(input.event_note ?? '').trim().slice(0, 200) || null };
  if (!Number.isInteger(v.person_id) || v.person_id <= 0) errors.push('Select an official.');
  for (const f of ['survey_start', 'survey_end']) {
    if (!isIsoDate(input[f])) errors.push(`${f === 'survey_start' ? 'Survey start' : 'Survey end'} must be a valid date (YYYY-MM-DD).`);
    v[f] = input[f];
  }
  if (!errors.length) {
    if (v.survey_start > v.survey_end) errors.push('Survey start cannot be after survey end.');
    if (v.survey_end > new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)) errors.push('Survey end cannot be in the future.');
  }
  v.sample_size = num(input.sample_size);
  if (!Number.isInteger(v.sample_size) || v.sample_size < 1 || v.sample_size > MAX_SAMPLE) {
    errors.push(`Sample size must be a whole number between 1 and ${MAX_SAMPLE.toLocaleString()}.`);
  }
  for (const f of PCT_FIELDS) {
    v[f] = num(input[f]);
    if (!Number.isFinite(v[f]) || v[f] < 0 || v[f] > 100) errors.push(`${PCT_LABELS[f]} must be between 0 and 100.`);
  }
  v.allow_mismatch = input.allow_mismatch === true || input.allow_mismatch === 'true';
  if (!errors.length) {
    const total = totalPct(v);
    v.total_flagged = Math.abs(total - 100) > 0.05 ? 1 : 0;
    if (Math.abs(total - 100) > 0.5 && !v.allow_mismatch) {
      errors.push(`Percentages total ${total}%, not 100%. Fix the values or tick “save despite mismatch”.`);
    }
  }
  return errors.length ? { errors } : { value: v };
}

export const CATEGORIES = ['constitutional', 'department', 'candidate'];
export const GROUNDS = ['Corruption', 'Neglect', 'Conviction'];
export const OUTCOME_BADGES = ['', 'recalled', 'succeeded'];

export function requireString(v, label, max, errors, { optional = false } = {}) {
  const s = String(v ?? '').trim();
  if (!s && !optional) errors.push(`${label} is required.`);
  if (s.length > max) errors.push(`${label} must be ${max} characters or fewer.`);
  return s;
}
