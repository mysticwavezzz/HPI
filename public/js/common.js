export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const signed = (n) => (n == null ? '–' : `${n > 0 ? '+' : ''}${Number(n).toFixed(1)}`);
export const pct = (n) => `${Number(n).toFixed(1)}%`;
export const fmtDate = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
export const fmtRange = (a, b) => (a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`);
export const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

/** fetch wrapper: JSON in/out, FormData passthrough, uniform errors. */
export async function api(url, { method = 'GET', body, admin = false } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (method !== 'GET') opts.headers['X-HPI-Request'] = '1';
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opts); } catch { throw new ApiError('Network error — check your connection and retry.', 0); }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  return data;
}

export function pfp(p, cls = 'pfp') {
  return p.pfp_path ? `<img class="${cls}" src="${esc(p.pfp_path)}" alt="" loading="lazy" width="64" height="64">`
    : `<span class="${cls}" aria-hidden="true">${esc(initials(p.full_name))}</span>`;
}
export const outcomeTag = (p) => (p.outcome_badge ? `<span class="tag ${esc(p.outcome_badge)}">${p.outcome_badge === 'recalled' ? 'Recalled' : 'Succeeded'}</span>` : '');
