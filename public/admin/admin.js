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
const shiftDate = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

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
  const modules = [['home', 'Start here'], ['roster', 'People'], ['polls', 'Poll Results'], ['elections', 'Elections & Recalls'], ['media', 'Media & Export']];
  app.innerHTML = `<header class="a-top"><div class="wrap"><span class="brand">HPI Admin</span><nav aria-label="Modules">
    ${modules.map(([k, l]) => `<button data-mod="${k}">${l}</button>`).join('')}</nav>
    <span class="who">${esc(user.username)} <a href="/" style="color:#dfe0ff">Public site</a><button id="logout">Sign out</button></span></div></header>
    <main class="wrap a-main" id="mod"></main>`;
  $$('[data-mod]').forEach((b) => b.addEventListener('click', () => go(b.dataset.mod)));
  $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); showLogin(); };
  go('home');
}

let pending = null; // one-shot hand-off between modules, e.g. { poll_person: 12 }
const MODS = { home: homeModule, roster: rosterModule, polls: pollsModule, elections: electionsModule, media: mediaModule };
function go(mod) {
  if (!MODS[mod]) mod = 'home';
  $$('[data-mod]').forEach((b) => (b.dataset.mod === mod ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  const root = $('#mod'); root.innerHTML = '<div class="state" role="status"><span class="spinner"></span>Loading…</div>';
  MODS[mod](root).catch((e) => { if (e.status === 401) return showLogin(); root.innerHTML = `<div class="state error" role="alert">${esc(e.message)}</div>`; });
}
const loadAgencies = async () => (agenciesCache = await api('/api/admin/agencies'));
const allPeople = () => api('/api/admin/people');


// ------------------------------------------------------------- start here
async function homeModule(root) {
  const [people, { races }, { active }] = await Promise.all([allPeople(), api('/api/admin/races'), api('/api/admin/recalls')]);
  const officials = people.filter((p) => p.category !== 'candidate'); const noPolls = officials.filter((p) => !p.summary);
  const tile = (id, icon, title, text) => `<button class="tile" data-go="${id}"><span class="ico" aria-hidden="true">${icon}</span><strong>${title}</strong><span>${text}</span></button>`;
  root.innerHTML = `<h2>What would you like to do?</h2>
    <p class="meta">Pick a task. Everything you enter here appears on the public site automatically — numbers, badges and charts are worked out for you.</p>
    <div class="tiles">
      ${tile('add-official', '👤', 'Add an official', 'A county officer or department head who gets an approval rating.')}
      ${tile('poll', '📊', 'Log poll results', 'Enter survey results for one or many people at once.')}
      ${tile('race', '🗳️', 'Set up an election', 'Create a race and add the candidates right there.')}
      ${tile('recall', '📢', 'Track a recall', 'Signature progress toward a recall petition.')}
    </div>
    <div class="a-card"><h3>Where things stand</h3><ul class="status">
      <li>${officials.length ? '✅' : '⬜'} <strong>${officials.length}</strong> official${officials.length === 1 ? '' : 's'} on the roster${noPolls.length ? ` — <span class="warn">${noPolls.length} without poll results yet (${noPolls.map((p) => esc(p.full_name)).join(', ')}), so they are hidden from the public site</span>` : ''}</li>
      <li>${races.length ? '✅' : '⬜'} <strong>${races.length}</strong> election${races.length === 1 ? '' : 's'} configured</li>
      <li>${active.length ? '✅' : '⬜'} <strong>${active.length}</strong> active recall${active.length === 1 ? '' : 's'}</li></ul>
      <p class="meta">Need to edit or archive someone? Use <a href="#" data-go="roster">People</a>.</p></div>`;
  $$('[data-go]', root).forEach((b) => b.onclick = (e) => {
    e.preventDefault(); const t = b.dataset.go;
    if (t === 'add-official') { pending = { add: 'constitutional' }; go('roster'); }
    else if (t === 'poll') go('polls'); else if (t === 'race') { pending = { race: true }; go('elections'); }
    else if (t === 'recall') { pending = { recall: true }; go('elections'); } else go(t);
  });
}

// ------------------------------------------------------------ 1. roster
const CAT_LABEL = { constitutional: 'Constitutional Officer', department: 'Department Head', candidate: 'Election Candidate' };

async function rosterModule(root, { tab = 'active', q = '' } = {}) {
  const archived = tab === 'archive';
  const [people] = await Promise.all([api(`/api/admin/people?archived=${archived ? 1 : 0}&q=${encodeURIComponent(q)}`), loadAgencies()]);
  root.innerHTML = `<h2>People</h2>
    <div class="subtabs" role="group" aria-label="Roster view"><button data-tab="active" aria-pressed="${!archived}">Active</button><button data-tab="archive" aria-pressed="${archived}">Archive</button></div>
    <div class="toolbar"><input type="search" id="q" class="grow" placeholder="${archived ? 'Search the archive…' : 'Search roster…'}" value="${esc(q)}" aria-label="Search">
      ${archived ? '' : '<button class="btn primary" id="add">+ Add person</button>'}</div>
    <div class="a-card">${people.length ? `<table class="rows"><thead><tr><th></th><th>Name</th><th>Title</th><th>Agency</th><th>Category</th><th>Badge</th><th>${archived ? 'Archived' : 'Latest net'}</th><th>Actions</th></tr></thead><tbody>
    ${people.map((p) => `<tr><td>${pfp(p, 'thumb')}</td><td><strong>${esc(p.full_name)}</strong><br><span class="meta">${esc(p.handle ?? '')}</span></td><td>${esc(p.title)}</td><td>${esc(p.agency_code ?? '–')}</td>
      <td>${CAT_LABEL[p.category]}</td><td>${p.outcome_badge ? `<span class="tag ${p.outcome_badge}">${p.outcome_badge === 'recalled' ? 'Recalled' : 'Succeeded'}</span>` : '–'}</td>
      <td>${archived ? `${fmtDate(p.archived_at?.slice(0, 10))}<br><span class="meta">${esc(p.archive_reason ?? '')}</span>` : p.summary ? `${signed(p.summary.net)} <span class="meta">${esc(p.summary.badge.icon)}</span>` : '<span class="meta">no polls</span>'}</td>
      <td style="white-space:nowrap">${!archived && p.category !== 'candidate' ? `<button class="btn sm primary" data-poll="${p.id}">+ Poll</button>` : ''}<button class="btn sm" data-edit="${p.id}">Edit</button>
      ${archived ? `<button class="btn sm" data-restore="${p.id}">Restore</button>` : `<button class="btn sm" data-archive="${p.id}">Archive</button>`}
      <button class="btn sm danger" data-del="${p.id}">Delete</button></td></tr>`).join('')}</tbody></table>`
      : `<div class="state">${q ? 'No matches.' : archived ? 'The archive is empty.' : 'No one on the roster yet.'}</div>`}</div>`;
  const reload = (o = {}) => rosterModule(root, { tab, q, ...o });
  $$('[data-tab]', root).forEach((b) => b.onclick = () => reload({ tab: b.dataset.tab, q: '' }));
  let t; $('#q', root).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => reload({ q: e.target.value }).then(() => { const i = $('#q'); i.focus(); i.setSelectionRange(99, 99); }), 300); });
  const by = (id) => people.find((p) => p.id === Number(id));
  $('#add', root)?.addEventListener('click', () => personForm(null, reload));
  if (pending?.add) { const cat = pending.add; pending = null; personForm(null, reload, cat); }
  $$('[data-edit]', root).forEach((b) => b.onclick = () => personForm(by(b.dataset.edit), reload));
  $$('[data-poll]', root).forEach((b) => b.onclick = () => { pending = { poll_person: Number(b.dataset.poll) }; go('polls'); });
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

const WHERE = {
  constitutional: ['Elected / constitutional officer', 'Shown in Approval Ratings (County Executive, DA, Sheriff, Councilors)'],
  department: ['Department head', 'Shown in Approval Ratings (Police Chief, Fire Chief, directors…)'],
  candidate: ['Election candidate', 'Only shown in an election forecast, not in Approval Ratings'],
};

function personForm(p, reload, presetCat) {
  const cat = p?.category ?? presetCat ?? 'constitutional';
  let created = null;
  const f = openForm(p ? `Edit ${p.full_name}` : 'Add a person', `<div class="form-grid">
    <div class="f full"><span>Where should they appear on the public site?</span><div class="where">${Object.entries(WHERE).map(([k, [l, h]]) => `<label class="opt"><input type="radio" name="category" value="${k}" ${cat === k ? 'checked' : ''}><span><strong>${l}</strong><small>${h}</small></span></label>`).join('')}</div></div>
    <label class="f">Full name<input name="full_name" required maxlength="100" autofocus value="${esc(p?.full_name)}"></label>
    <label class="f">Handle <span class="hint">optional, e.g. @M_ysticWavezzz</span><input name="handle" maxlength="50" value="${esc(p?.handle)}"></label>
    <label class="f">Title<input name="title" required maxlength="120" placeholder="e.g. Sheriff, or First Assistant District Attorney" value="${esc(p?.title)}"></label>
    <label class="f">Agency<select name="agency_id"><option value="">— none —</option>${agenciesCache.map((a) => `<option value="${a.id}" ${p?.agency_id === a.id ? 'selected' : ''}>${esc(a.code)} — ${esc(a.name)}</option>`).join('')}</select>
      <button type="button" class="btn sm" id="new-ag" style="justify-self:start">+ Agency not listed?</button></label>
    <div class="f full">Photo <span class="hint">optional — auto-cropped to a circle</span>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span id="pv">${p ? pfp(p, 'thumb') : ''}</span><input type="file" name="pfp" accept="image/*"><input name="pfp_url" type="url" placeholder="…or paste an image URL" style="flex:1;min-width:200px">
      ${p?.pfp_path ? '<label><input type="checkbox" name="remove_pfp"> Remove current photo</label>' : ''}</div></div>
    <details class="full"><summary>Advanced: card badge</summary><label class="f" style="margin-top:8px">Badge on their card <span class="hint">Set automatically when a recall or race is concluded</span><select name="outcome_badge"><option value="">None</option><option value="recalled" ${p?.outcome_badge === 'recalled' ? 'selected' : ''}>Recalled</option><option value="succeeded" ${p?.outcome_badge === 'succeeded' ? 'selected' : ''}>Succeeded</option></select></label></details></div>`,
  async (form) => {
    const fd = new FormData(form);
    if (!fd.get('pfp')?.size) fd.delete('pfp');
    fd.set('remove_pfp', form.remove_pfp?.checked ? 'true' : 'false');
    const saved = await api(p ? `/api/admin/people/${p.id}` : '/api/admin/people', { method: p ? 'PUT' : 'POST', body: fd });
    toast('Saved.'); if (!p && saved.category !== 'candidate') created = saved;
    reload();
  }, { submitLabel: p ? 'Save changes' : 'Add person' });
  dlg.addEventListener('close', () => { if (created) offerPoll(created); }, { once: true });
  f.pfp.addEventListener('change', () => { const file = f.pfp.files[0]; if (file) $('#pv').innerHTML = `<img class="thumb" src="${URL.createObjectURL(file)}" alt="Preview">`; });
  $('#new-ag').onclick = () => {
    const code = prompt('Agency code (e.g. HCDAO):'); if (!code) return;
    const name = prompt('Full agency name (optional):') ?? '';
    api('/api/admin/agencies', { method: 'POST', body: { code, name } }).then(async (a) => {
      await loadAgencies(); f.agency_id.innerHTML = '<option value="">— none —</option>' + agenciesCache.map((x) => `<option value="${x.id}">${esc(x.code)} — ${esc(x.name)}</option>`).join(''); f.agency_id.value = a.id;
    }).catch((e) => toast(e.message, 'error'));
  };
}

/** After adding an official: nudge toward the step that makes them visible publicly. */
function offerPoll(person) {
  setTimeout(() => openForm(`${person.full_name} added`, `<p>They won’t appear on the public site until they have at least one poll result.</p>`,
    async () => { pending = { poll_person: person.id }; go('polls'); }, { submitLabel: 'Log their poll results now' }), 60);
}

// ---------------------------------------------------------- 2. poll data
const PCT_FIELDS = [['strong_approve', 'Strong Approve'], ['some_approve', 'Some Approve'], ['some_disapprove', 'Some Disapprove'], ['strong_disapprove', 'Strong Disapprove'], ['neutral', 'No Opinion (auto)']];

function rowHtml(people, d = {}) {
  return `<tr data-row><td><select name="person_id" aria-label="Official"><option value="">Select…</option>${['constitutional', 'department', 'candidate'].map((c) => `<optgroup label="${WHERE[c][0]}s">${people.filter((p) => p.category === c).map((p) => `<option value="${p.id}" ${d.person_id === p.id ? 'selected' : ''}>${esc(p.full_name)}</option>`).join('')}</optgroup>`).join('')}</select></td>
    <td><input type="date" name="survey_start" aria-label="Survey start" value="${d.survey_start ?? ''}"><br><input type="date" name="survey_end" aria-label="Survey end" value="${d.survey_end ?? ''}"></td>
    <td><input type="number" name="sample_size" min="1" step="1" aria-label="Sample size n" value="${d.sample_size ?? ''}"></td>
    ${PCT_FIELDS.map(([k, l]) => `<td><input type="number" name="${k}" min="0" max="100" step="0.1" aria-label="${l} %" value="${d[k] ?? ''}" ${k === 'neutral' && d[k] != null && d[k] !== '' ? 'data-dirty="1"' : ''}></td>`).join('')}
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
  container.addEventListener('input', (e) => {
    const tr = e.target.closest('[data-row]'); if (!tr || e.target.name === 'allow_mismatch') return;
    const neutral = tr.querySelector('[name=neutral]');
    if (e.target === neutral) neutral.dataset.dirty = '1';
    else if (PCT_FIELDS.slice(0, 4).some(([k]) => k === e.target.name) && !neutral.dataset.dirty) {
      // No-opinion is simply whatever is left over unless the admin types it themselves.
      const vals = PCT_FIELDS.slice(0, 4).map(([k]) => val(tr, k));
      if (vals.every((v) => v !== '')) neutral.value = Math.max(0, Math.round((100 - vals.reduce((t, v) => t + Number(v), 0)) * 10) / 10);
    }
    refreshPreview(tr);
  });
  container.addEventListener('change', (e) => { if (e.target.name === 'allow_mismatch') return; });
}

async function pollsModule(root, { tab = 'entry', q = '' } = {}) {
  const people = await allPeople();
  root.innerHTML = `<h2>Poll Results</h2><div class="subtabs" role="group"><button data-tab="entry" aria-pressed="${tab === 'entry'}">Log new results</button><button data-tab="log" aria-pressed="${tab === 'log'}">Edit / delete past results</button><button data-tab="history" aria-pressed="${tab === 'history'}">Edit history</button></div><div id="pane"></div>`;
  $$('[data-tab]', root).forEach((b) => b.onclick = () => pollsModule(root, { tab: b.dataset.tab }));
  const pane = $('#pane', root);
  if (tab === 'entry') batchPane(pane, people); else if (tab === 'log') await logPane(pane, people, q); else await historyPane(pane, q);
}

function batchPane(pane, people) {
  pane.innerHTML = `<div class="a-card"><p class="meta"><strong>One row = one survey result.</strong> Type the four answer percentages; “No opinion” fills in the rest. Net score, margin of error and the public badge are worked out automatically. Person missing? Add them under <a href="#" id="tp">People</a> first.</p>
    <div class="toolbar"><button class="btn" id="addrow">+ Add row</button><button class="btn" id="dup">Copy last row’s dates</button><button class="btn primary" id="save">Save batch</button></div>
    <table class="rows" id="tbl">${HEAD}<tbody></tbody></table><div id="res"></div></div>`;
  $('#tp', pane).onclick = (e) => { e.preventDefault(); go('roster'); };
  const tbody = $('tbody', pane);
  const add = (d) => { d = { survey_start: shiftDate(d.survey_end ?? today(), -4), ...d }; tbody.insertAdjacentHTML('beforeend', rowHtml(people, d)); const tr = tbody.lastElementChild; refreshPreview(tr); return tr; };
  add({ survey_end: today(), person_id: pending?.poll_person }); pending = null;
  bindRows(tbody);
  $('#addrow', pane).onclick = () => add({ survey_end: today() }).querySelector('select').focus();
  $('#dup', pane).onclick = () => { const last = tbody.lastElementChild; if (last) { const r = readRow(last); add({ survey_start: r.survey_start, survey_end: r.survey_end, sample_size: r.sample_size }); } };
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
async function electionsModule(root, { tab = 'races', open = false } = {}) {
  root.innerHTML = `<h2>Elections &amp; Recalls</h2><div class="subtabs" role="group"><button data-tab="races" aria-pressed="${tab === 'races'}">Elections</button><button data-tab="recalls" aria-pressed="${tab === 'recalls'}">Recalls</button></div><div id="pane"></div>`;
  $$('[data-tab]', root).forEach((b) => b.onclick = () => electionsModule(root, { tab: b.dataset.tab }));
  const wantRace = pending?.race; const wantRecall = pending?.recall; pending = null;
  if (wantRecall && tab === 'races') return electionsModule(root, { tab: 'recalls', open: true });
  await (tab === 'races' ? racesPane : recallsPane)($('#pane', root), () => electionsModule(root, { tab }), wantRace || (open && tab === 'races'), open && tab === 'recalls');
}

async function racesPane(pane, reload, autoOpen) {
  const [{ races, issues }, people] = await Promise.all([api('/api/admin/races'), allPeople()]);
  pane.innerHTML = `<div class="toolbar"><button class="btn primary" id="add">+ Set up a new election</button></div>
    ${races.length ? races.map((r) => `<div class="a-card"><div class="toolbar"><h3 class="grow" style="font-size:20px">${esc(r.title)} ${r.status === 'concluded' ? '<span class="tag succeeded">Concluded</span>' : ''}</h3>
      <button class="btn sm" data-edit="${r.id}">Edit</button>
      ${r.status === 'active' ? `<button class="btn sm" data-conclude="${r.id}">Conclude…</button>` : `<button class="btn sm" data-reopen="${r.id}">Reopen</button>`}
      <button class="btn sm danger" data-del="${r.id}">Delete</button></div>
      <p class="meta">${r.lead.total ? `${r.lead.total.toLocaleString('en-US')} votes · ` : 'No votes yet · '}${r.candidates.map((c) => `${esc(c.full_name)} ${c.votes.toLocaleString('en-US')}${c.vote_share != null ? ` (${pct(c.vote_share)})` : ''}`).join(' · ')}</p></div>`).join('')
    : '<div class="state">No races configured. Create one to populate the public forecast.</div>'}`;
  $('#add', pane).onclick = () => raceForm(null, people, issues, reload);
  if (autoOpen) raceForm(null, people, issues, reload);
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

function raceForm(r, peopleIn, issues, reload) {
  const people = [...peopleIn];
  const opts = (sel) => `<option value="">Choose a person…</option><option value="new">＋ Add a new candidate…</option>${people.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.full_name)}${p.category === 'candidate' ? '' : ` — ${esc(p.title)}`}</option>`).join('')}`;
  const f = openForm(r ? 'Edit election' : 'Set up an election', `<div class="form-grid">
    <label class="f full">Election name<input name="title" required maxlength="150" placeholder="2026 District Attorney Special Election" value="${esc(r?.title)}"></label>
    <div class="f">Expected turnout <span class="hint">optional, number of voters</span><div><input name="turnout_min" type="number" min="0" placeholder="from" value="${r?.turnout_min ?? ''}"> – <input name="turnout_max" type="number" min="0" placeholder="to" value="${r?.turnout_max ?? ''}"></div></div>
    <div class="full"><strong>Candidates and votes counted</strong> <span class="hint meta">Enter actual vote counts — percentages are calculated for you. Leave at 0 until votes come in.</span>
      <div id="cands"></div><div class="toolbar"><button type="button" class="btn sm" id="addc">+ Add candidate</button><span id="sum" class="meta"></span></div></div>
    <details class="full"><summary>Optional: voter issue priorities (feeds the stacked bar chart)</summary><p class="meta">For each candidate’s supporters, enter how many named each issue as their top priority. Percentages are calculated.</p><div id="prio" class="prio-grid"></div></details></div>`,
  async (form) => {
    const candidates = readCands(); const priorities = {};
    $$('[data-prio]', form).forEach((row) => { priorities[row.dataset.prio] = Object.fromEntries(issues.map((i, k) => [i, row.querySelectorAll('input')[k].value])); });
    const body = { title: form.title.value, turnout_min: form.turnout_min.value, turnout_max: form.turnout_max.value, candidates, priorities };
    await api(r ? `/api/admin/races/${r.id}` : '/api/admin/races', { method: r ? 'PUT' : 'POST', body }); toast('Election saved.'); reload();
  }, { wide: true, submitLabel: 'Save election' });
  const cands = $('#cands', dlg);
  const readCands = () => [...cands.querySelectorAll('.cand-row')].map((c) => ({ person_id: c.querySelector('select').value, votes: c.querySelector('input[type=number]').value })).filter((c) => c.person_id && c.person_id !== 'new');
  const drawPrio = () => {
    const chosen = readCands(); const old = {};
    $$('[data-prio]', dlg).forEach((row) => { old[row.dataset.prio] = [...row.querySelectorAll('input')].map((i) => i.value); });
    $('#prio', dlg).innerHTML = `<b>Supporters of</b>${issues.map((i) => `<b>${esc(i)}</b>`).join('')}` + chosen.map((c) => {
      const p = people.find((x) => x.id === Number(c.person_id)); const cur = r?.priorities.filter((x) => x.person_id === p.id);
      return `<span style="display:contents" data-prio="${p.id}"><span>${esc(p.full_name)}</span>${issues.map((i, k) => `<input type="number" min="0" step="1" aria-label="${esc(p.full_name)} ${esc(i)} (count)" value="${old[p.id]?.[k] ?? cur?.find((x) => x.issue === i)?.count ?? ''}">`).join('')}</span>`;
    }).join('');
  };
  const sum = () => {
    // Live preview of the calculated shares (the server derives the real ones from the counts).
    const rows = [...cands.querySelectorAll('.cand-row')]; const t = rows.reduce((s, c) => s + (Number(c.querySelector('input[type=number]').value) || 0), 0);
    rows.forEach((c) => { const v = Number(c.querySelector('input[type=number]').value) || 0; c.querySelector('.calc').textContent = t > 0 ? `${Math.round((v / t) * 1000) / 10}%` : '—'; });
    $('#sum', dlg).textContent = t > 0 ? `${t.toLocaleString('en-US')} votes counted` : 'No votes yet — the public page will say “Awaiting votes”.';
  };
  const addCand = (c) => {
    cands.insertAdjacentHTML('beforeend', `<div class="cand-wrap"><div class="cand-row"><select aria-label="Candidate">${opts(c?.id)}</select><input type="number" min="0" step="1" aria-label="Votes counted" placeholder="votes" value="${c?.votes ?? 0}"><span class="calc meta" aria-label="Calculated share">—</span><button type="button" class="btn sm danger" data-rm aria-label="Remove candidate">✕</button></div>
      <div class="newp" hidden><input placeholder="Full name" data-n="name" maxlength="100"><input placeholder="Title" data-n="title" maxlength="120"><select data-n="ag" aria-label="Agency"><option value="">Agency…</option>${agenciesCache.map((a) => `<option value="${a.id}">${esc(a.code)}</option>`).join('')}</select><button type="button" class="btn sm primary" data-create>Create</button></div></div>`);
  };
  (r?.candidates ?? [null, null]).forEach(addCand);
  $('#addc', dlg).onclick = () => addCand(null);
  cands.addEventListener('click', async (e) => {
    const wrap = e.target.closest('.cand-wrap'); if (!wrap) return;
    if (e.target.closest('[data-rm]')) { wrap.remove(); sum(); drawPrio(); }
    if (e.target.closest('[data-create]')) {
      const g = (k) => wrap.querySelector(`[data-n=${k}]`).value; const btn = e.target;
      await busy(btn, async () => {
        try {
          const fd = new FormData(); fd.set('full_name', g('name')); fd.set('title', g('title')); fd.set('agency_id', g('ag')); fd.set('category', 'candidate');
          const p = await api('/api/admin/people', { method: 'POST', body: fd });
          people.push(p); $$('.cand-row select', dlg).forEach((sel) => { const keep = sel.value; sel.innerHTML = opts(); sel.value = keep; });
          wrap.querySelector('.cand-row select').value = p.id; wrap.querySelector('.newp').hidden = true; toast(`${p.full_name} added to the roster.`); sum(); drawPrio();
        } catch (err) { toast(err.message, 'error'); }
      });
    }
  });
  cands.addEventListener('change', (e) => {
    if (e.target.matches('.cand-row select')) { e.target.closest('.cand-wrap').querySelector('.newp').hidden = e.target.value !== 'new'; if (e.target.value === 'new') e.target.closest('.cand-wrap').querySelector('[data-n=name]').focus(); }
    sum(); drawPrio();
  });
  cands.addEventListener('input', sum);
  sum(); drawPrio();
}

async function recallsPane(pane, reload, _x, autoOpen) {
  const [{ active, archived, grounds }, people] = await Promise.all([api('/api/admin/recalls'), allPeople()]);
  pane.innerHTML = `<div class="toolbar"><button class="btn primary" id="add">+ Track a new recall</button></div>
    <h3>Active petitions</h3>${active.length ? active.map((r) => `<div class="a-card"><div class="toolbar"><strong class="grow">${esc(r.person.full_name)} <span class="meta">${esc(r.person.title)}</span> <span class="tag">${esc(r.grounds)}</span></strong>
      <button class="btn sm" data-edit="${r.id}">Update</button><button class="btn sm" data-arch="${r.id}">Conclude → archive</button><button class="btn sm danger" data-del="${r.id}">Delete</button></div>
      <div class="progress"><i style="width:${r.progress_pct}%"></i></div><span class="meta">${r.verified} / ${r.threshold} verified (${r.progress_pct}%)${r.milestone ? ` · milestone ${r.milestone}` : ''}</span></div>`).join('') : '<div class="state">No active petitions.</div>'}
    <h3 style="margin-top:22px">Referendum archive</h3><div class="a-card">${archived.length ? `<table><thead><tr><th>Concluded</th><th>Official</th><th>Grounds</th><th>Outcome</th><th class="num">Result</th><th></th></tr></thead><tbody>
    ${archived.map((r) => `<tr><td>${fmtDate(r.concluded_on)}</td><td>${esc(r.person.full_name)}</td><td>${esc(r.grounds)}</td><td>${esc(r.outcome)}</td><td class="num">${r.result_pct != null ? `${pct(r.result_pct)} Yes` : '–'}</td><td><button class="btn sm danger" data-del="${r.id}">Delete</button></td></tr>`).join('')}</tbody></table>` : '<div class="state">Archive is empty.</div>'}</div>`;
  const by = (id) => active.find((r) => r.id === Number(id));
  const form = (r) => openForm(r ? 'Update recall petition' : 'New recall petition', `<div class="form-grid">
    <label class="f">Who is the recall against?<select name="person_id" required><option value="">Select…</option>${people.map((p) => `<option value="${p.id}" ${r?.person_id === p.id ? 'selected' : ''}>${esc(p.full_name)} — ${esc(p.title)}</option>`).join('')}</select></label>
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
  if (autoOpen) form(null);
  $$('[data-edit]', pane).forEach((b) => b.onclick = () => form(by(b.dataset.edit)));
  $$('[data-del]', pane).forEach((b) => b.onclick = () => confirmBox('Delete recall record?', 'This removes it from the public site permanently.', 'Delete', async () => { await api(`/api/admin/recalls/${b.dataset.del}`, { method: 'DELETE' }); reload(); }));
  $$('[data-arch]', pane).forEach((b) => b.onclick = () => {
    const r = by(b.dataset.arch);
    openForm(`Archive recall of ${r.person.full_name}`, `<div class="form-grid"><label class="f">Outcome<select name="outcome"><option>Recalled</option><option>Retained</option><option>Failed to qualify</option></select></label>
      <label class="f">Yes votes <span class="hint">optional</span><input name="votes_yes" type="number" min="0" step="1"></label><label class="f">No votes <span class="hint">% is calculated</span><input name="votes_no" type="number" min="0" step="1"></label>
      <label class="f">Concluded on<input name="concluded_on" type="date" value="${today()}"></label></div><p class="meta">A “Recalled” outcome also puts the Recalled badge on the official’s card (they stay active until you archive them).</p>`,
    async (f) => { await api(`/api/admin/recalls/${r.id}/archive`, { method: 'POST', body: { outcome: f.outcome.value, votes_yes: f.votes_yes.value, votes_no: f.votes_no.value, concluded_on: f.concluded_on.value } }); toast('Moved to archive.'); reload(); }, { submitLabel: 'Move to archive' });
  });
}

// -------------------------------------------------------------- 4. media
async function mediaModule(root) {
  const people = (await allPeople()).filter((p) => p.category !== 'candidate' && p.summary);
  root.innerHTML = `<h2>Media &amp; Export</h2>
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
