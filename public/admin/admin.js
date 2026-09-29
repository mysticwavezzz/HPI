import { api, ApiError, esc, $, $$, fmtDate, signed, pct, pfp, initials } from '/js/common.js';
import { derive, totalPct } from '/shared/stats.js';

const app = $('#app');
const dlg = $('#dlg');
let user = null;
let agenciesCache = [];

// ----------------------------------------------------------------- helpers
function toast(msg, kind = 'ok') {
  const t = document.createElement('div'); t.className = `toast ${kind === 'error' ? 'error' : ''}`; t.textContent = msg;
  $('#toasts').append(t); setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}
const fail = (e) => { if (e.status === 401) return showLogin(); toast(e.message, 'error'); };
const errList = (e) => `<div class="err" role="alert">${esc(e.message)}${e.data?.errors?.length > 1 ? `<ul>${e.data.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
const busy = async (btn, fn) => { btn.disabled = true; try { return await fn(); } finally { btn.disabled = false; } };
const ago = (ts) => ts?.replace('T', ' ').slice(0, 16) ?? '';
const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => (v === '' ? null : Number(v));

/** Modal form helper. onSubmit(formEl) may throw; errors render inline. */
function openForm(title, bodyHtml, onSubmit, { submitLabel = 'Save', wide = false } = {}) {
  dlg.style.width = wide ? 'min(1100px, 96vw)' : 'min(680px, 96vw)';
  dlg.innerHTML = `<form class="dlg-body" method="dialog" novalidate><div class="dlg-head"><h2 id="dlg-title">${esc(title)}</h2><button type="button" class="close" data-x>Cancel</button></div>
    <div data-body>${bodyHtml}</div><div data-err></div><p style="margin-top:14px"><button class="btn primary" data-submit type="submit">${esc(submitLabel)}</button></p></form>`;
  dlg.setAttribute('aria-labelledby', 'dlg-title');
  const form = $('form', dlg);
  $('[data-x]', dlg).onclick = () => dlg.close();
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const b = $('[data-submit]', dlg); $('[data-err]', dlg).innerHTML = '';
    await busy(b, async () => {
      try { await onSubmit(form); dlg.close(); } catch (e) {
        if (e.status === 401) return showLogin();
        $('[data-err]', dlg).innerHTML = errList(e);
        if (!(e instanceof ApiError)) console.error(e);
      }
    });
  });
  dlg.showModal();
  return form;
}
const confirmBox = (title, msg, label, fn) => openForm(title, `<p>${msg}</p>`, fn, { submitLabel: label });

// -------------------------------------------------------------------- auth
function showLogin(msg = '') {
  user = null;
  app.innerHTML = `<div class="login"><div class="a-card"><h2>HPI Admin</h2>
    <form id="login" class="form-grid" style="grid-template-columns:1fr">
      <label class="f">Username<input name="username" autocomplete="username" required autofocus></label>
      <label class="f">Password<input name="password" type="password" autocomplete="current-password" required></label>
      <div class="err" role="alert">${esc(msg)}</div><button class="btn primary">Sign in</button></form>
    <p class="meta"><a href="/">← Public site</a></p></div></div>`;
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target; const b = $('button', f);
    await busy(b, async () => {
      try { await api('/api/auth/login', { method: 'POST', body: { username: f.username.value, password: f.password.value } }); await boot(); }
      catch (err) { $('.err', f).textContent = err.message; }
    });
  });
}

async function boot() {
  try { ({ user } = await api('/api/auth/me')); } catch (e) { return showLogin(); }
  const modules = [['roster', 'Roster Management'], ['polls', 'Poll Data Entry'], ['elections', 'Election Config'], ['media', 'Media Export']];
  app.innerHTML = `<header class="a-top"><div class="wrap"><span class="brand">HPI Admin</span><nav aria-label="Modules">
    ${modules.map(([k, l]) => `<button data-mod="${k}">${l}</button>`).join('')}</nav>
    <span class="who">${esc(user.username)} <a href="/" style="color:#dfe0ff">Public site</a><button id="logout">Sign out</button></span></div></header>
    <main class="wrap a-main" id="mod"></main>`;
  $$('[data-mod]').forEach((b) => b.addEventListener('click', () => go(b.dataset.mod)));
  $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); showLogin(); };
  go(sessionStorage.getItem('hpi-mod') || 'roster');
}

const MODS = { roster: rosterModule, polls: pollsModule, elections: electionsModule, media: mediaModule };
function go(mod) {
  if (!MODS[mod]) mod = 'roster';
  sessionStorage.setItem('hpi-mod', mod);
  $$('[data-mod]').forEach((b) => (b.dataset.mod === mod ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  const root = $('#mod'); root.innerHTML = '<div class="state" role="status"><span class="spinner"></span>Loading…</div>';
  MODS[mod](root).catch((e) => { if (e.status === 401) return showLogin(); root.innerHTML = `<div class="state error" role="alert">${esc(e.message)}</div>`; });
}
const loadAgencies = async () => (agenciesCache = await api('/api/admin/agencies'));
const allPeople = () => api('/api/admin/people');

// ------------------------------------------------------------ 1. roster
const CAT_LABEL = { constitutional: 'Constitutional Officer', department: 'Department Head', candidate: 'Election Candidate' };

async function rosterModule(root, { tab = 'active', q = '' } = {}) {
  const archived = tab === 'archive';
  const [people] = await Promise.all([api(`/api/admin/people?archived=${archived ? 1 : 0}&q=${encodeURIComponent(q)}`), loadAgencies()]);
  root.innerHTML = `<h2>Roster Management</h2>
    <div class="subtabs" role="group" aria-label="Roster view"><button data-tab="active" aria-pressed="${!archived}">Active</button><button data-tab="archive" aria-pressed="${archived}">Archive</button></div>
    <div class="toolbar"><input type="search" id="q" class="grow" placeholder="${archived ? 'Search the archive…' : 'Search roster…'}" value="${esc(q)}" aria-label="Search">
      ${archived ? '' : '<button class="btn primary" id="add">+ Add official / candidate</button>'}</div>
    <div class="a-card">${people.length ? `<table class="rows"><thead><tr><th></th><th>Name</th><th>Title</th><th>Agency</th><th>Category</th><th>Badge</th><th>${archived ? 'Archived' : 'Latest net'}</th><th>Actions</th></tr></thead><tbody>
    ${people.map((p) => `<tr><td>${pfp(p, 'thumb')}</td><td><strong>${esc(p.full_name)}</strong><br><span class="meta">${esc(p.handle ?? '')}</span></td><td>${esc(p.title)}</td><td>${esc(p.agency_code ?? '–')}</td>
      <td>${CAT_LABEL[p.category]}</td><td>${p.outcome_badge ? `<span class="tag ${p.outcome_badge}">${p.outcome_badge === 'recalled' ? 'Recalled' : 'Succeeded'}</span>` : '–'}</td>
      <td>${archived ? `${fmtDate(p.archived_at?.slice(0, 10))}<br><span class="meta">${esc(p.archive_reason ?? '')}</span>` : p.summary ? `${signed(p.summary.net)} <span class="meta">${esc(p.summary.badge.icon)}</span>` : '<span class="meta">no polls</span>'}</td>
      <td style="white-space:nowrap"><button class="btn sm" data-edit="${p.id}">Edit</button>
      ${archived ? `<button class="btn sm" data-restore="${p.id}">Restore</button>` : `<button class="btn sm" data-archive="${p.id}">Archive</button>`}
      <button class="btn sm danger" data-del="${p.id}">Delete</button></td></tr>`).join('')}</tbody></table>`
      : `<div class="state">${q ? 'No matches.' : archived ? 'The archive is empty.' : 'No one on the roster yet.'}</div>`}</div>`;
  const reload = (o = {}) => rosterModule(root, { tab, q, ...o });
  $$('[data-tab]', root).forEach((b) => b.onclick = () => reload({ tab: b.dataset.tab, q: '' }));
  let t; $('#q', root).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => reload({ q: e.target.value }).then(() => { const i = $('#q'); i.focus(); i.setSelectionRange(99, 99); }), 300); });
  const by = (id) => people.find((p) => p.id === Number(id));
  $('#add', root)?.addEventListener('click', () => personForm(null, reload));
  $$('[data-edit]', root).forEach((b) => b.onclick = () => personForm(by(b.dataset.edit), reload));
  $$('[data-archive]', root).forEach((b) => b.onclick = () => {
    const p = by(b.dataset.archive);
    openForm(`Archive ${p.full_name}`, `<p>Removes them from the active roster and public grid. Their polling history is preserved and searchable in the Archive tab.</p>
      <label class="f">Reason <span class="hint">(resigned, recalled, left office…)</span><input name="reason" maxlength="200"></label>`,
    async (f) => { await api(`/api/admin/people/${p.id}/archive`, { method: 'POST', body: { reason: f.reason.value } }); toast('Archived.'); reload(); }, { submitLabel: 'Archive' });
  });
  $$('[data-restore]', root).forEach((b) => b.onclick = async () => { try { await api(`/api/admin/people/${b.dataset.restore}/unarchive`, { method: 'POST' }); toast('Restored.'); reload(); } catch (e) { fail(e); } });
  $$('[data-del]', root).forEach((b) => b.onclick = () => {
    const p = by(b.dataset.del);
    openForm(`Delete ${p.full_name}?`, `<p class="err">This permanently deletes the person and <strong>all their poll data</strong>. Consider archiving instead.</p>
      <label class="f">Type the full name to confirm<input name="confirm" autocomplete="off" placeholder="${esc(p.full_name)}"></label>`,
    async (f) => { await api(`/api/admin/people/${p.id}`, { method: 'DELETE', body: { confirm_name: f.confirm.value } }); toast('Deleted.'); reload(); }, { submitLabel: 'Delete permanently' });
  });
}

function personForm(p, reload) {
  const f = openForm(p ? `Edit ${p.full_name}` : 'Add official / candidate', `<div class="form-grid">
    <label class="f">Full name<input name="full_name" required maxlength="100" value="${esc(p?.full_name)}"></label>
    <label class="f">Handle <span class="hint">e.g. @M_ysticWavezzz</span><input name="handle" maxlength="50" value="${esc(p?.handle)}"></label>
    <label class="f full">Government title<input name="title" required maxlength="120" placeholder="First Assistant District Attorney" value="${esc(p?.title)}"></label>
    <label class="f">Branch / agency<select name="agency_id"><option value="">— none —</option>${agenciesCache.map((a) => `<option value="${a.id}" ${p?.agency_id === a.id ? 'selected' : ''}>${esc(a.code)} — ${esc(a.name)}</option>`).join('')}</select>
      <button type="button" class="btn sm" id="new-ag" style="justify-self:start">+ New agency</button></label>
    <div class="f">Category<div class="pill-toggle" role="radiogroup" aria-label="Category">${Object.entries(CAT_LABEL).map(([k, l]) => `<label><input type="radio" name="category" value="${k}" ${(p?.category ?? 'constitutional') === k ? 'checked' : ''}>${l}</label>`).join('')}</div></div>
    <label class="f">Outcome badge <span class="hint">Shown on their card; archive manually later</span><select name="outcome_badge"><option value="">None</option><option value="recalled" ${p?.outcome_badge === 'recalled' ? 'selected' : ''}>Recalled</option><option value="succeeded" ${p?.outcome_badge === 'succeeded' ? 'selected' : ''}>Succeeded</option></select></label>
    <div class="f full">Profile picture <span class="hint">Auto-cropped to a circle plus a portrait thumbnail. Max 5 MB.</span>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span id="pv">${p ? pfp(p, 'thumb') : ''}</span><input type="file" name="pfp" accept="image/*"><input name="pfp_url" type="url" placeholder="…or external image URL" style="flex:1;min-width:200px">
      ${p?.pfp_path ? '<label><input type="checkbox" name="remove_pfp"> Remove current</label>' : ''}</div></div></div>`,
  async (form) => {
    const fd = new FormData(form);
    if (!fd.get('pfp')?.size) fd.delete('pfp');
    fd.set('remove_pfp', form.remove_pfp?.checked ? 'true' : 'false');
    await api(p ? `/api/admin/people/${p.id}` : '/api/admin/people', { method: p ? 'PUT' : 'POST', body: fd });
    toast('Saved.'); reload();
  }, { submitLabel: p ? 'Save changes' : 'Add to roster' });
  f.pfp.addEventListener('change', () => { const file = f.pfp.files[0]; if (file) $('#pv').innerHTML = `<img class="thumb" src="${URL.createObjectURL(file)}" alt="Preview">`; });
  $('#new-ag').onclick = () => {
    const code = prompt('Agency code (e.g. HCDAO):'); if (!code) return;
    const name = prompt('Full agency name (optional):') ?? '';
    api('/api/admin/agencies', { method: 'POST', body: { code, name } }).then(async (a) => {
      await loadAgencies(); const sel = f.agency_id; sel.innerHTML = '<option value="">— none —</option>' + agenciesCache.map((x) => `<option value="${x.id}">${esc(x.code)} — ${esc(x.name)}</option>`).join(''); sel.value = a.id;
    }).catch((e) => toast(e.message, 'error'));
  };
}

// ---------------------------------------------------------- 2. poll data
const PCT_FIELDS = [['strong_approve', 'Strong Approve'], ['some_approve', 'Some Approve'], ['some_disapprove', 'Some Disapprove'], ['strong_disapprove', 'Strong Disapprove'], ['neutral', 'No Opinion']];

function rowHtml(people, d = {}) {
  return `<tr data-row><td><select name="person_id" aria-label="Official"><option value="">Select…</option>${people.map((p) => `<option value="${p.id}" ${d.person_id === p.id ? 'selected' : ''}>${esc(p.full_name)}${p.category === 'candidate' ? ' (cand.)' : ''}</option>`).join('')}</select></td>
    <td><input type="date" name="survey_start" aria-label="Survey start" value="${d.survey_start ?? ''}"><br><input type="date" name="survey_end" aria-label="Survey end" value="${d.survey_end ?? ''}"></td>
    <td><input type="number" name="sample_size" min="1" step="1" aria-label="Sample size n" value="${d.sample_size ?? ''}"></td>
    ${PCT_FIELDS.map(([k, l]) => `<td><input type="number" name="${k}" min="0" max="100" step="0.1" aria-label="${l} %" value="${d[k] ?? ''}"></td>`).join('')}
    <td class="preview" data-preview></td>
    <td><input class="note" name="event_note" maxlength="200" placeholder="Optional event note" aria-label="Event note" value="${esc(d.event_note)}"></td>
    <td><button type="button" class="btn sm danger" data-rm aria-label="Remove row">✕</button></td></tr>`;
}
const HEAD = `<thead><tr><th>Official</th><th>Survey start / end</th><th>n</th>${PCT_FIELDS.map(([, l]) => `<th>${l} %</th>`).join('')}<th>Total · Net · ±MoE (computed)</th><th>Milestone / event</th><th></th></tr></thead>`;

const val = (tr, n) => tr.querySelector(`[name=${n}]`).value;
function readRow(tr) {
  const r = {}; for (const n of ['person_id', 'survey_start', 'survey_end', 'sample_size', 'event_note', ...PCT_FIELDS.map(([k]) => k)]) r[n] = val(tr, n);
  r.allow_mismatch = tr.querySelector('[name=allow_mismatch]')?.checked ?? false; return r;
}
/** Live preview using the shared stats module — the server recomputes authoritatively on save. */
function refreshPreview(tr) {
  const r = readRow(tr); const cell = tr.querySelector('[data-preview]');
  const nums = Object.fromEntries(PCT_FIELDS.map(([k]) => [k, Number(r[k]) || 0]));
  const n = Number(r.sample_size);
  const filled = PCT_FIELDS.some(([k]) => r[k] !== '');
  if (!filled) { cell.textContent = ''; return; }
  const total = totalPct(nums); const off = Math.abs(total - 100) > 0.05;
  const d = n > 0 ? derive({ ...nums, sample_size: n }) : null;
  tr.classList.toggle('flag', off);
  cell.innerHTML = `<span class="${off ? 'warn' : 'ok'}">Σ ${total}%${off ? ' ⚠' : ' ✓'}</span>${d ? `<br>Net ${signed(d.net)} · ±${d.moe}` : ''}
    ${Math.abs(total - 100) > 0.5 ? `<br><label class="warn"><input type="checkbox" name="allow_mismatch" ${r.allow_mismatch ? 'checked' : ''}> save despite mismatch</label>` : ''}`;
}
function bindRows(container) {
  container.addEventListener('input', (e) => { const tr = e.target.closest('[data-row]'); if (tr && e.target.name !== 'allow_mismatch') refreshPreview(tr); });
  container.addEventListener('change', (e) => { if (e.target.name === 'allow_mismatch') return; });
}

async function pollsModule(root, { tab = 'entry', q = '' } = {}) {
  const people = await allPeople();
  root.innerHTML = `<h2>Poll Data Entry</h2><div class="subtabs" role="group"><button data-tab="entry" aria-pressed="${tab === 'entry'}">Batch logger</button><button data-tab="log" aria-pressed="${tab === 'log'}">Logged polls</button><button data-tab="history" aria-pressed="${tab === 'history'}">Edit history</button></div><div id="pane"></div>`;
  $$('[data-tab]', root).forEach((b) => b.onclick = () => pollsModule(root, { tab: b.dataset.tab }));
  const pane = $('#pane', root);
  if (tab === 'entry') batchPane(pane, people); else if (tab === 'log') await logPane(pane, people, q); else await historyPane(pane, q);
}

function batchPane(pane, people) {
  pane.innerHTML = `<div class="a-card"><p class="meta">Each row is one survey result. Net score, margin of error and the public status badge are computed automatically on save — they cannot be entered.</p>
    <div class="toolbar"><button class="btn" id="addrow">+ Add row</button><button class="btn" id="dup">Duplicate last row</button><button class="btn primary" id="save">Save batch</button></div>
    <table class="rows" id="tbl">${HEAD}<tbody></tbody></table><div id="res"></div></div>`;
  const tbody = $('tbody', pane);
  const add = (d) => { tbody.insertAdjacentHTML('beforeend', rowHtml(people, d)); const tr = tbody.lastElementChild; refreshPreview(tr); return tr; };
  add({ survey_end: today() });
  bindRows(tbody);
  $('#addrow', pane).onclick = () => add({ survey_start: '', survey_end: today() }).querySelector('select').focus();
  $('#dup', pane).onclick = () => { const last = tbody.lastElementChild; if (last) add({ ...readRow(last), person_id: null, ...Object.fromEntries(PCT_FIELDS.map(([k]) => [k, ''])) }); };
  tbody.addEventListener('click', (e) => { if (e.target.closest('[data-rm]')) { if (tbody.children.length > 1) e.target.closest('tr').remove(); else toast('Keep at least one row.', 'error'); } });
  $('#save', pane).onclick = (e) => busy(e.target, async () => {
    const rows = [...tbody.children]; rows.forEach((r) => r.classList.remove('bad')); $$('.err', tbody).forEach((x) => x.remove());
    try {
      const out = await api('/api/admin/polls/batch', { method: 'POST', body: { rows: rows.map(readRow) } });
      $('#res', pane).innerHTML = `<div class="ok" role="status"><strong>Saved ${out.saved} poll${out.saved === 1 ? '' : 's'}.</strong> Public badges now read: <ul>${out.badges.map((b) => `<li>${esc(b.name)}: net ${signed(b.net)} — ${esc(b.badge.icon)} ${esc(b.badge.label)}</li>`).join('')}</ul></div>`;
      tbody.innerHTML = ''; add({ survey_end: today() }); toast('Batch saved.');
    } catch (err) {
      if (err.status === 422 && err.data?.rowErrors) {
        for (const [i, msgs] of Object.entries(err.data.rowErrors)) {
          rows[i].classList.add('bad');
          rows[i].querySelector('[data-preview]').insertAdjacentHTML('beforeend', `<div class="err">${msgs.map(esc).join('<br>')}</div>`);
        }
        toast('Fix the highlighted rows — nothing was saved.', 'error');
      } else fail(err);
    }
  });
}

async function logPane(pane, people, q) {
  const rows = await api(`/api/admin/polls?q=${encodeURIComponent(q)}`);
  pane.innerHTML = `<div class="toolbar"><input type="search" id="q" class="grow" placeholder="Search by official or event note…" value="${esc(q)}"></div>
    <div class="a-card">${rows.length ? `<table><thead><tr><th>Official</th><th>Survey dates</th><th class="num">n</th><th class="num">Approve</th><th class="num">Disapprove</th><th class="num">Neutral</th><th class="num">Net</th><th class="num">±MoE</th><th>Event</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.full_name)}${r.archived_at ? ' <span class="tag">archived</span>' : ''}${r.total_flagged ? ' <span class="warn" title="Saved with total ≠ 100%">⚠</span>' : ''}</td><td>${fmtDate(r.survey_start)} – ${fmtDate(r.survey_end)}</td><td class="num">${r.sample_size}</td>
      <td class="num">${pct(r.approve)}</td><td class="num">${pct(r.disapprove)}</td><td class="num">${pct(r.neutral)}</td><td class="num">${signed(r.net)}</td><td class="num">±${r.moe}</td><td>${esc(r.event_note ?? '')}</td>
      <td style="white-space:nowrap"><button class="btn sm" data-edit="${r.id}">Edit</button> <button class="btn sm danger" data-del="${r.id}">Delete</button></td></tr>`).join('')}</tbody></table>
      ${rows.length >= 500 ? '<p class="meta">Showing the latest 500 — narrow with search.</p>' : ''}` : '<div class="state">No polls logged yet.</div>'}</div>`;
  let t; $('#q', pane).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => logPane(pane, people, e.target.value).then(() => { const i = $('#q'); i.focus(); i.setSelectionRange(99, 99); }), 300); });
  const again = () => logPane(pane, people, q);
  $$('[data-edit]', pane).forEach((b) => b.onclick = () => {
    const r = rows.find((x) => x.id === Number(b.dataset.edit));
    const f = openForm(`Edit poll #${r.id} — ${r.full_name}`, `<div class="tablewrap"><table class="rows" id="etbl">${HEAD}<tbody>${rowHtml(people, r)}</tbody></table></div><p class="meta">Every change is recorded in the edit history.</p>`,
      async () => { await api(`/api/admin/polls/${r.id}`, { method: 'PUT', body: readRow($('[data-row]', dlg)) }); toast('Poll updated.'); again(); }, { wide: true });
    const tr = $('[data-row]', dlg); $('[data-rm]', tr).remove(); bindRows(tr.parentElement); refreshPreview(tr);
  });
  $$('[data-del]', pane).forEach((b) => b.onclick = () => {
    const r = rows.find((x) => x.id === Number(b.dataset.del));
    confirmBox('Delete this poll?', `Delete ${esc(r.full_name)}’s poll of ${fmtDate(r.survey_end)}? The prior values stay in the edit history.`, 'Delete',
      async () => { await api(`/api/admin/polls/${r.id}`, { method: 'DELETE' }); toast('Deleted.'); again(); });
  });
}

const fmtVals = (v) => (v ? Object.entries(v).filter(([k]) => k !== 'person_id').map(([k, x]) => `${k}: ${x ?? '–'}`).join('\n') : '—');
async function historyPane(pane, q) {
  const rows = await api(`/api/admin/polls/history?q=${encodeURIComponent(q)}`);
  pane.innerHTML = `<div class="toolbar"><input type="search" id="q" class="grow" placeholder="Search history (official, user, type, values, poll id)…" value="${esc(q)}"></div>
    <div class="a-card">${rows.length ? `<table><thead><tr><th>When (UTC)</th><th>User</th><th>Change</th><th>Official</th><th>Poll</th><th>Prior values</th><th>New values</th></tr></thead><tbody>
    ${rows.map((h) => `<tr><td>${ago(h.changed_at)}</td><td>${esc(h.changed_by)}</td><td><span class="tag">${h.change_type}</span></td><td>${esc(h.person_name)}</td><td>#${h.poll_id}</td><td class="hist-vals">${esc(fmtVals(h.prior_values))}</td><td class="hist-vals">${esc(fmtVals(h.new_values))}</td></tr>`).join('')}</tbody></table>`
      : '<div class="state">No history matches.</div>'}</div>`;
  let t; $('#q', pane).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => historyPane(pane, e.target.value).then(() => { const i = $('#q'); i.focus(); i.setSelectionRange(99, 99); }), 300); });
}

// ------------------------------------------------------ 3. elections
async function electionsModule(root, { tab = 'races' } = {}) {
  root.innerHTML = `<h2>Election &amp; Recall Configurator</h2><div class="subtabs" role="group"><button data-tab="races" aria-pressed="${tab === 'races'}">Race Builder</button><button data-tab="recalls" aria-pressed="${tab === 'recalls'}">Recall Tracker</button></div><div id="pane"></div>`;
  $$('[data-tab]', root).forEach((b) => b.onclick = () => electionsModule(root, { tab: b.dataset.tab }));
  await (tab === 'races' ? racesPane : recallsPane)($('#pane', root), () => electionsModule(root, { tab }));
}

async function racesPane(pane, reload) {
  const [{ races, issues }, people] = await Promise.all([api('/api/admin/races'), allPeople()]);
  pane.innerHTML = `<div class="toolbar"><button class="btn primary" id="add">+ New race</button></div>
    ${races.length ? races.map((r) => `<div class="a-card"><div class="toolbar"><h3 class="grow" style="font-size:20px">${esc(r.title)} ${r.status === 'concluded' ? '<span class="tag succeeded">Concluded</span>' : ''}</h3>
      <button class="btn sm" data-edit="${r.id}">Edit</button>
      ${r.status === 'active' ? `<button class="btn sm" data-conclude="${r.id}">Conclude…</button>` : `<button class="btn sm" data-reopen="${r.id}">Reopen</button>`}
      <button class="btn sm danger" data-del="${r.id}">Delete</button></div>
      <p class="meta">MoE ±${r.moe}% · Turnout ${r.turnout_min ?? '?'}–${r.turnout_max ?? '?'} · ${r.candidates.map((c) => `${esc(c.full_name)} ${pct(c.vote_share)}`).join(' · ')}${r.undecided ? ` · Undecided ${pct(r.undecided)}` : ''}</p></div>`).join('')
    : '<div class="state">No races configured. Create one to populate the public forecast.</div>'}`;
  $('#add', pane).onclick = () => raceForm(null, people, issues, reload);
  const by = (id) => races.find((r) => r.id === Number(id));
  $$('[data-edit]', pane).forEach((b) => b.onclick = () => raceForm(by(b.dataset.edit), people, issues, reload));
  $$('[data-del]', pane).forEach((b) => b.onclick = () => confirmBox('Delete race?', `Delete “${esc(by(b.dataset.del).title)}” from the public forecast?`, 'Delete', async () => { await api(`/api/admin/races/${b.dataset.del}`, { method: 'DELETE' }); reload(); }));
  $$('[data-reopen]', pane).forEach((b) => b.onclick = async () => { try { await api(`/api/admin/races/${b.dataset.reopen}/reopen`, { method: 'POST' }); reload(); } catch (e) { fail(e); } });
  $$('[data-conclude]', pane).forEach((b) => b.onclick = () => {
    const r = by(b.dataset.conclude);
    openForm('Conclude race', `<p>The winner’s roster card gets a “Succeeded” badge. They stay active until you archive them.</p><label class="f">Winner<select name="w">${r.candidates.map((c) => `<option value="${c.id}">${esc(c.full_name)}</option>`).join('')}</select></label>`,
      async (f) => { await api(`/api/admin/races/${r.id}/conclude`, { method: 'POST', body: { winner_person_id: Number(f.w.value) } }); toast('Race concluded.'); reload(); }, { submitLabel: 'Conclude race' });
  });
}

function raceForm(r, people, issues, reload) {
  const opts = (sel) => `<option value="">Select from roster…</option>${people.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.full_name)}${p.category === 'candidate' ? '' : ` (${esc(p.title)})`}</option>`).join('')}`;
  const f = openForm(r ? 'Edit race' : 'New race', `<div class="form-grid">
    <label class="f full">Election title<input name="title" required maxlength="150" placeholder="2026 District Attorney Special Election" value="${esc(r?.title)}"></label>
    <label class="f">Margin of error (± pts)<input name="moe" type="number" step="0.1" min="0" max="25" required value="${r?.moe ?? ''}"></label>
    <div class="f">Estimated turnout (voters)<div><input name="turnout_min" type="number" min="0" placeholder="min" value="${r?.turnout_min ?? ''}"> – <input name="turnout_max" type="number" min="0" placeholder="max" value="${r?.turnout_max ?? ''}"></div></div>
    <div class="full"><strong>Candidates &amp; projected vote share</strong><div id="cands"></div><button type="button" class="btn sm" id="addc">+ Add candidate</button> <span id="sum" class="meta"></span></div>
    <div class="full"><strong>Issue priorities</strong> <span class="meta">Per candidate’s supporters; each row should total 100. Leave blank to skip.</span><div id="prio" class="prio-grid"></div></div></div>`,
  async (form) => {
    const candidates = readCands(); const priorities = {};
    $$('[data-prio]', form).forEach((row) => { priorities[row.dataset.prio] = Object.fromEntries(issues.map((i, k) => [i, row.querySelectorAll('input')[k].value])); });
    const body = { title: form.title.value, moe: form.moe.value, turnout_min: form.turnout_min.value, turnout_max: form.turnout_max.value, candidates, priorities };
    await api(r ? `/api/admin/races/${r.id}` : '/api/admin/races', { method: r ? 'PUT' : 'POST', body }); toast('Race saved.'); reload();
  }, { wide: true });
  const cands = $('#cands', dlg);
  const readCands = () => [...cands.children].map((c) => ({ person_id: c.querySelector('select').value, vote_share: c.querySelector('input').value })).filter((c) => c.person_id);
  const drawPrio = () => {
    const chosen = readCands(); const old = {};
    $$('[data-prio]', dlg).forEach((row) => { old[row.dataset.prio] = [...row.querySelectorAll('input')].map((i) => i.value); });
    $('#prio', dlg).innerHTML = `<b>Supporters of</b>${issues.map((i) => `<b>${esc(i)}</b>`).join('')}` + chosen.map((c) => {
      const p = people.find((x) => x.id === Number(c.person_id)); const cur = r?.priorities.filter((x) => x.person_id === p.id);
      return `<span style="display:contents" data-prio="${p.id}"><span>${esc(p.full_name)}</span>${issues.map((i, k) => `<input type="number" min="0" max="100" step="0.1" aria-label="${esc(p.full_name)} ${esc(i)}" value="${old[p.id]?.[k] ?? cur?.find((x) => x.issue === i)?.pct ?? ''}">`).join('')}</span>`;
    }).join('');
  };
  const sum = () => { const t = readCands().reduce((s, c) => s + (Number(c.vote_share) || 0), 0); $('#sum', dlg).innerHTML = `Total ${Math.round(t * 10) / 10}% ${t > 100.05 ? '<span class="warn">⚠ exceeds 100</span>' : `· undecided ${Math.round((100 - t) * 10) / 10}%`}`; };
  const addCand = (c) => {
    cands.insertAdjacentHTML('beforeend', `<div class="cand-row"><select aria-label="Candidate">${opts(c?.id)}</select><input type="number" min="0" max="100" step="0.1" aria-label="Vote share %" value="${c?.vote_share ?? ''}"><button type="button" class="btn sm danger" aria-label="Remove candidate">✕</button></div>`);
  };
  (r?.candidates ?? [null, null]).forEach(addCand);
  $('#addc', dlg).onclick = () => addCand(null);
  cands.addEventListener('click', (e) => { if (e.target.closest('button')) { e.target.closest('.cand-row').remove(); sum(); drawPrio(); } });
  cands.addEventListener('input', sum); cands.addEventListener('change', () => { sum(); drawPrio(); });
  sum(); drawPrio();
}

async function recallsPane(pane, reload) {
  const [{ active, archived, grounds }, people] = await Promise.all([api('/api/admin/recalls'), allPeople()]);
  pane.innerHTML = `<div class="toolbar"><button class="btn primary" id="add">+ New recall petition</button></div>
    <h3>Active petitions</h3>${active.length ? active.map((r) => `<div class="a-card"><div class="toolbar"><strong class="grow">${esc(r.person.full_name)} <span class="meta">${esc(r.person.title)}</span> <span class="tag">${esc(r.grounds)}</span></strong>
      <button class="btn sm" data-edit="${r.id}">Update</button><button class="btn sm" data-arch="${r.id}">Conclude → archive</button><button class="btn sm danger" data-del="${r.id}">Delete</button></div>
      <div class="progress"><i style="width:${r.progress_pct}%"></i></div><span class="meta">${r.verified} / ${r.threshold} verified (${r.progress_pct}%)${r.milestone ? ` · milestone ${r.milestone}` : ''}</span></div>`).join('') : '<div class="state">No active petitions.</div>'}
    <h3 style="margin-top:22px">Referendum archive</h3><div class="a-card">${archived.length ? `<table><thead><tr><th>Concluded</th><th>Official</th><th>Grounds</th><th>Outcome</th><th class="num">Result</th><th></th></tr></thead><tbody>
    ${archived.map((r) => `<tr><td>${fmtDate(r.concluded_on)}</td><td>${esc(r.person.full_name)}</td><td>${esc(r.grounds)}</td><td>${esc(r.outcome)}</td><td class="num">${r.result_pct != null ? pct(r.result_pct) : '–'}</td><td><button class="btn sm danger" data-del="${r.id}">Delete</button></td></tr>`).join('')}</tbody></table>` : '<div class="state">Archive is empty.</div>'}</div>`;
  const by = (id) => active.find((r) => r.id === Number(id));
  const form = (r) => openForm(r ? 'Update recall petition' : 'New recall petition', `<div class="form-grid">
    <label class="f">Target official<select name="person_id" required><option value="">Select…</option>${people.map((p) => `<option value="${p.id}" ${r?.person_id === p.id ? 'selected' : ''}>${esc(p.full_name)} — ${esc(p.title)}</option>`).join('')}</select></label>
    <label class="f">Statutory grounds<select name="grounds">${grounds.map((g) => `<option ${r?.grounds === g ? 'selected' : ''}>${g}</option>`).join('')}</select></label>
    <label class="f">Signature threshold (goal)<input name="threshold" type="number" min="1" required value="${r?.threshold ?? ''}"></label>
    <label class="f">Milestone <span class="hint">optional checkpoint</span><input name="milestone" type="number" min="1" value="${r?.milestone ?? ''}"></label>
    <label class="f">Verified signatures<input name="verified" type="number" min="0" required value="${r?.verified ?? 0}"></label>
    <label class="f">Filed on<input name="filed_on" type="date" value="${r?.filed_on ?? ''}"></label>
    <label class="f full">Notes<input name="notes" maxlength="500" value="${esc(r?.notes)}"></label></div>`,
  async (f) => {
    const body = { person_id: f.person_id.value, grounds: f.grounds.value, threshold: f.threshold.value, milestone: f.milestone.value, verified: f.verified.value, filed_on: f.filed_on.value, notes: f.notes.value };
    await api(r ? `/api/admin/recalls/${r.id}` : '/api/admin/recalls', { method: r ? 'PUT' : 'POST', body }); toast('Saved.'); reload();
  });
  $('#add', pane).onclick = () => form(null);
  $$('[data-edit]', pane).forEach((b) => b.onclick = () => form(by(b.dataset.edit)));
  $$('[data-del]', pane).forEach((b) => b.onclick = () => confirmBox('Delete recall record?', 'This removes it from the public site permanently.', 'Delete', async () => { await api(`/api/admin/recalls/${b.dataset.del}`, { method: 'DELETE' }); reload(); }));
  $$('[data-arch]', pane).forEach((b) => b.onclick = () => {
    const r = by(b.dataset.arch);
    openForm(`Archive recall of ${r.person.full_name}`, `<div class="form-grid"><label class="f">Outcome<select name="outcome"><option>Recalled</option><option>Retained</option><option>Failed to qualify</option></select></label>
      <label class="f">Result % <span class="hint">recall vote, optional</span><input name="result_pct" type="number" step="0.1" min="0" max="100"></label>
      <label class="f">Concluded on<input name="concluded_on" type="date" value="${today()}"></label></div><p class="meta">A “Recalled” outcome also puts the Recalled badge on the official’s card (they stay active until you archive them).</p>`,
    async (f) => { await api(`/api/admin/recalls/${r.id}/archive`, { method: 'POST', body: { outcome: f.outcome.value, result_pct: f.result_pct.value, concluded_on: f.concluded_on.value } }); toast('Moved to archive.'); reload(); }, { submitLabel: 'Move to archive' });
  });
}

// -------------------------------------------------------------- 4. media
async function mediaModule(root) {
  const people = (await allPeople()).filter((p) => p.category !== 'candidate' && p.summary);
  root.innerHTML = `<h2>Media Syndication &amp; Export</h2>
    <div class="a-card"><h3>Summary card image</h3><p class="meta">High-resolution (2880×1620) PNG of current net approval, ready for Discord or news embeds. Leave all unchecked for the top 8 by net.</p>
      <fieldset style="border:0;padding:0;display:flex;flex-wrap:wrap;gap:6px 16px">${people.map((p) => `<label><input type="checkbox" name="ids" value="${p.id}"> ${esc(p.full_name)}</label>`).join('')}</fieldset>
      <p><button class="btn primary" id="card">Generate card</button></p><div id="cardout"></div></div>
    <div class="a-card"><h3>Press release formatter</h3><div class="toolbar"><label class="f">Outlet<select id="outlet"><option value="times">The Jamestown Times</option><option value="independent">The Harrison Independent</option></select></label>
      <label class="f">Include polls from the last <span class="hint">days before newest survey</span><input id="days" type="number" min="1" max="365" value="14"></label><button class="btn primary" id="gen" style="align-self:end">Generate</button></div><div id="pressout"></div></div>
    <div class="a-card"><h3>Full database backup</h3><p class="meta">Everything: roster, polls (with derived values), edit history, races and recalls.</p>
      <a class="btn primary" href="/api/admin/media/export.json" download>Download JSON</a> <a class="btn" href="/api/admin/media/export.csv" download>Download CSV (polls)</a></div>`;
  $('#card', root).onclick = (e) => busy(e.target, async () => {
    const ids = $$('[name=ids]:checked', root).map((c) => c.value).join(',');
    try {
      const res = await fetch(`/api/admin/media/card.png?ids=${ids}`, { credentials: 'same-origin' });
      if (!res.ok) throw new ApiError((await res.json().catch(() => ({}))).error || 'Could not render the card.', res.status);
      const url = URL.createObjectURL(await res.blob());
      $('#cardout', root).innerHTML = `<img src="${url}" alt="Summary card preview" style="max-width:100%;border:1px solid var(--rule)"><p><a class="btn primary" href="${url}" download="hpi-summary-card.png">Download PNG</a></p>`;
    } catch (err) { fail(err); }
  });
  $('#gen', root).onclick = (e) => busy(e.target, async () => {
    try {
      const d = await api(`/api/admin/media/press?outlet=${$('#outlet').value}&days=${Number($('#days').value) || 14}`);
      $('#pressout', root).innerHTML = `<h4>${esc(d.headline)}</h4><div class="two-col"><div><label class="f">Markdown<textarea class="out" readonly id="md">${esc(d.markdown)}</textarea></label><button class="btn sm" data-copy="md">Copy</button> <button class="btn sm" data-dl="md">Download .md</button></div>
        <div><label class="f">Plain text<textarea class="out" readonly id="tx">${esc(d.text)}</textarea></label><button class="btn sm" data-copy="tx">Copy</button> <button class="btn sm" data-dl="tx">Download .txt</button></div></div>`;
      $$('[data-copy]', root).forEach((b) => b.onclick = () => navigator.clipboard.writeText($(`#${b.dataset.copy}`).value).then(() => toast('Copied.'), () => toast('Copy failed — select the text manually.', 'error')));
      $$('[data-dl]', root).forEach((b) => b.onclick = () => {
        const a = document.createElement('a'); a.download = `press-release.${b.dataset.dl === 'md' ? 'md' : 'txt'}`;
        a.href = URL.createObjectURL(new Blob([$(`#${b.dataset.dl}`).value], { type: 'text/plain' })); a.click();
      });
    } catch (err) { fail(err); }
  });
}

boot();
