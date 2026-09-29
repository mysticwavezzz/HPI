import { api, esc, $, $$, signed, pct, fmtDate, fmtRange, pfp, outcomeTag } from './common.js';

const main = $('#main');
const loading = (what) => `<div class="state" role="status"><span class="spinner"></span>Loading ${what}…</div>`;
const errorBox = (e, retry) => `<div class="state error" role="alert">${esc(e.message)} <button class="chip" data-retry="${retry}">Retry</button></div>`;
const COLORS = { approve: '#1c6b3a', disapprove: '#a51c1c', net: '#0b5cad' };
let charts = [];
const killCharts = () => { charts.forEach((c) => c.destroy()); charts = []; };

// ------------------------------------------------------------- routing
function route() {
  const forecast = location.hash.startsWith('#/forecast');
  $('#nav-approval').toggleAttribute('aria-current', !forecast); if (!forecast) $('#nav-approval').setAttribute('aria-current', 'page');
  $('#nav-forecast').toggleAttribute('aria-current', forecast); if (forecast) $('#nav-forecast').setAttribute('aria-current', 'page');
  document.title = `${forecast ? 'Election & Recall Forecast' : 'Approval Ratings'} — Harrison Polling Institute`;
  killCharts();
  (forecast ? renderForecast : renderHub)();
}
window.addEventListener('hashchange', route);
main.addEventListener('click', (e) => { if (e.target.dataset.retry) route(); });

// ----------------------------------------------------------------- hub
const FILTERS = [['all', 'All Officials'], ['constitutional', 'Constitutional Officers'], ['department', 'Department Leadership']];
let hub = { officials: [], filter: 'all' };

async function renderHub() {
  main.innerHTML = loading('approval ratings');
  try {
    const { officials, updated } = await api('/api/public/officials');
    hub.officials = officials;
    $('#updated').textContent = updated ? `Latest survey: ${fmtDate(updated)}` : 'No surveys yet';
    drawHub();
  } catch (e) { main.innerHTML = errorBox(e, 'hub'); }
}

function drawHub() {
  const { officials, filter } = hub;
  const shown = officials.filter((o) => filter === 'all' || o.category === filter);
  const chips = FILTERS.map(([k, label]) => {
    const count = officials.filter((o) => k === 'all' || o.category === k).length;
    return `<button class="chip" aria-pressed="${k === filter}" data-filter="${k}">${label}<small>${count}</small></button>`;
  }).join('');
  main.innerHTML = `
    <div class="section-head"><h2>Leadership Approval Ratings</h2><span class="meta">Select a card for the full trend</span></div>
    <div class="filters" role="group" aria-label="Filter officials">${chips}</div>
    ${shown.length ? `<div class="grid">${shown.map(cardHtml).join('')}</div>`
      : '<div class="state">No officials to show yet. Poll results appear here once an administrator logs them.</div>'}`;
  $$('[data-filter]').forEach((b) => b.addEventListener('click', () => { hub.filter = b.dataset.filter; drawHub(); $(`[data-filter="${hub.filter}"]`).focus(); }));
  $$('[data-open]').forEach((b) => b.addEventListener('click', () => openDetail(Number(b.dataset.open))));
}

function cardHtml(o) {
  const s = o.summary;
  const cls = s.net > 0 ? 'pos' : s.net < 0 ? 'neg' : '';
  const tip = s.badge.delta == null ? '' : `${signed(s.badge.delta)} net since previous cycle`;
  return `<button class="card" data-open="${o.id}" aria-label="${esc(o.full_name)}, net approval ${signed(s.net)}, ${esc(s.badge.label)}. Open trend chart.">
    <span class="card-head">${pfp(o)}<span>
      <h3>${esc(o.full_name)}</h3>
      <span class="role">${esc(o.title)}</span><br>
      ${o.agency_code ? `<span class="tag">${esc(o.agency_code)}</span>` : ''}${outcomeTag(o)}
    </span></span>
    <span class="netrow"><span class="net ${cls}"><small>Net approval</small>${signed(s.net)}</span>
      <span class="badge ${s.badge.key}" title="${esc(tip)}">${esc(s.badge.icon)} ${esc(s.badge.label)}${s.badge.delta != null ? ` (${signed(s.badge.delta)})` : ''}</span></span>
    <span class="stack" aria-hidden="true"><i class="a" style="width:${s.approve}%"></i><i class="n" style="width:${s.neutral}%"></i><i class="d" style="width:${s.disapprove}%"></i></span>
    <span class="trio"><span class="a"><b>${pct(s.approve)}</b>Approve</span><span class="d"><b>${pct(s.disapprove)}</b>Disapprove</span><span class="n"><b>${pct(s.neutral)}</b>Neutral / no opinion</span></span>
    <span class="foot">n = ${s.n.toLocaleString('en-US')} · ±${s.moe} pts · ${fmtRange(s.survey_start, s.survey_end)}</span>
  </button>`;
}

// ------------------------------------------------------- detail modal
const dlg = $('#dlg');
dlg.addEventListener('close', killCharts);
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
let detailChart = null;

async function openDetail(id) {
  dlg.innerHTML = `<div class="dlg-body">${loading('trend')}</div>`;
  dlg.showModal();
  await loadTrend(id, 'weekly');
}

async function loadTrend(id, interval) {
  try {
    const d = await api(`/api/public/officials/${id}/trend?interval=${interval}`);
    drawDetail(d);
  } catch (e) {
    dlg.innerHTML = `<div class="dlg-body">${errorBox(e, 'x')}<p><button class="close" id="dlg-close">Close</button></p></div>`;
    $('#dlg-close').onclick = () => dlg.close();
  }
}

const pinPlugin = {
  id: 'pins',
  afterDatasetsDraw(chart, _a, opts) {
    const { ctx, chartArea, scales } = chart; ctx.save();
    (opts.indices || []).forEach((idx, n) => {
      const x = scales.x.getPixelForValue(idx);
      ctx.strokeStyle = '#52514e'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, chartArea.top + 14); ctx.lineTo(x, chartArea.bottom); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#1a1a6e'; ctx.beginPath(); ctx.arc(x, chartArea.top + 8, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '700 10px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(n + 1), x, chartArea.top + 8.5);
    });
    ctx.restore();
  },
};

function drawDetail({ person, interval, points, summary }) {
  const pins = []; // {idx, note, date}
  points.forEach((p, i) => p.events.forEach((ev) => pins.push({ idx: i, ...ev })));
  const labels = points.map((p) => (interval === 'monthly' ? new Date(`${p.key}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
    : new Date(`${p.end}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })));
  dlg.innerHTML = `<div class="dlg-body">
    <div class="dlg-head"><div class="card-head">${pfp(person)}<div><h2 id="dlg-title">${esc(person.full_name)}</h2><span class="role">${esc(person.title)} · ${esc(person.agency_code ?? '')}</span><br>${outcomeTag(person)}
      ${summary ? `<span class="badge ${summary.badge.key}">${esc(summary.badge.icon)} ${esc(summary.badge.label)}</span> <span class="meta">Net ${signed(summary.net)}</span>` : ''}</div></div>
      <button class="close" id="dlg-close">Close</button></div>
    <div class="seg" role="group" aria-label="Chart interval">
      <button data-int="weekly" aria-pressed="${interval === 'weekly'}">Weekly</button><button data-int="monthly" aria-pressed="${interval === 'monthly'}">Monthly</button></div>
    ${points.length ? `<div class="chart-box"><canvas id="trend" role="img" aria-label="Line chart of approval, disapproval and net favorability for ${esc(person.full_name)}. A data table follows."></canvas></div>
      <p class="legend"><span style="--c:${COLORS.approve}">Approve %</span><span style="--c:${COLORS.disapprove}">Disapprove %</span><span class="dot" style="--c:${COLORS.net}">Net favorability</span><span class="meta">Numbered pins mark events. Hover or tap points for n, dates and ±MoE.</span></p>
      ${pins.length ? `<ol class="events" aria-label="Timeline events">${pins.map((p) => `<li><strong>${fmtDate(p.date)}:</strong> ${esc(p.note)}</li>`).join('')}</ol>` : ''}
      <details><summary>View data table</summary><div class="tablewrap"><table><thead><tr><th>Period</th><th class="num">Approve</th><th class="num">Disapprove</th><th class="num">Net</th><th class="num">n</th><th class="num">±MoE</th></tr></thead><tbody>
      ${points.map((p) => `<tr><td>${fmtRange(p.start, p.end)}</td><td class="num">${pct(p.approve)}</td><td class="num">${pct(p.disapprove)}</td><td class="num">${signed(p.net)}</td><td class="num">${p.n.toLocaleString('en-US')}</td><td class="num">±${p.moe}</td></tr>`).join('')}</tbody></table></div></details>`
      : '<div class="state">No poll data logged for this official yet.</div>'}
  </div>`;
  $('#dlg-close').onclick = () => dlg.close();
  $$('[data-int]', dlg).forEach((b) => b.addEventListener('click', () => loadTrend(person.id, b.dataset.int)));
  if (!points.length) return;
  killCharts();
  const ds = (label, key, color, extra = {}) => ({ label, data: points.map((p) => p[key]), borderColor: color, backgroundColor: color, borderWidth: 2.5, tension: 0.25, pointRadius: points.length > 40 ? 1.5 : 3.5, pointHoverRadius: 6, ...extra });
  detailChart = new Chart($('#trend'), {
    type: 'line',
    plugins: [pinPlugin],
    data: { labels, datasets: [
      ds('Approve', 'approve', COLORS.approve, { pointStyle: 'circle' }),
      ds('Disapprove', 'disapprove', COLORS.disapprove, { pointStyle: 'rectRot' }),
      ds('Net favorability', 'net', COLORS.net, { borderDash: [2, 5], borderWidth: 3, pointStyle: 'triangle' }),
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 6 } },
      scales: { y: { title: { display: true, text: 'Percent / net points' }, grid: { color: '#e1e0d9' }, grace: '8%' }, x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 14 } } },
      plugins: {
        pins: { indices: pins.map((p) => p.idx) },
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: ([i]) => fmtRange(points[i.dataIndex].start, points[i.dataIndex].end),
            label: (c) => `${c.dataset.label}: ${c.dataset.label.startsWith('Net') ? signed(c.parsed.y) : pct(c.parsed.y)}`,
            afterBody: ([i]) => {
              const p = points[i.dataIndex];
              return [`Sample size: n = ${p.n.toLocaleString('en-US')}`, `Margin of error: ±${p.moe} pts`, ...p.events.map((e) => `📌 ${e.note}`)];
            },
          },
        },
      },
    },
  });
  charts.push(detailChart);
}

// ------------------------------------------------------------ forecast
async function renderForecast() {
  main.innerHTML = loading('forecasts');
  try {
    const { races, recalls, referendums } = await api('/api/public/forecast');
    $('#updated').textContent = 'Forecast center';
    main.innerHTML = `<div class="section-head"><h2>Special Election Forecast</h2><span class="meta">Projected vote share with margin of error</span></div>
      ${races.length ? races.map(raceHtml).join('') : '<div class="state">No elections are being forecast right now.</div>'}
      <div class="section-head"><h2>Recall Radar</h2><span class="meta">Active petitions and archive</span></div>
      <div class="panel"><h3>Active recall petitions</h3>
      ${recalls.length ? recalls.map(recallHtml).join('') : '<p class="meta">No active recall petitions.</p>'}</div>
      <div class="panel"><h3>Referendum archive</h3>${referendumHtml(referendums)}</div>`;
    races.forEach(drawPriorities);
  } catch (e) { main.innerHTML = errorBox(e, 'forecast'); }
}

function raceHtml(r) {
  const maxShare = Math.max(...r.candidates.map((c) => c.vote_share), 0);
  const scale = Math.max(50, Math.ceil((maxShare + r.moe) / 10) * 10);
  const leader = r.candidates.find((c) => c.id === r.lead.leader);
  const lean = leader && r.lead.gap != null
    ? (r.lead.decisive ? `${leader.full_name} leads by ${r.lead.gap} pts — outside the margin of error` : `${leader.full_name} leads by ${r.lead.gap} pts — within the margin of error`) : '';
  return `<section class="panel" aria-labelledby="race-${r.id}">
    <h3 id="race-${r.id}">${esc(r.title)}</h3>
    <div>${r.status === 'concluded' ? '<span class="status-chip" style="background:var(--yes)">Concluded</span>' : ''}
      <span class="status-chip">±${r.moe}% margin of error</span>
      ${r.turnout_min != null || r.turnout_max != null ? `<span class="status-chip" style="background:var(--ink-2)">Est. turnout ${[r.turnout_min, r.turnout_max].filter((x) => x != null).map((x) => x.toLocaleString('en-US')).join('–')} voters</span>` : ''}</div>
    ${lean ? `<p class="lede">${esc(lean)}.</p>` : ''}
    <div class="race" role="list">${r.candidates.map((c) => {
      const w = (c.vote_share / scale) * 100; const wl = (Math.max(c.vote_share - r.moe, 0) / scale) * 100; const wr = (Math.min(c.vote_share + r.moe, scale) / scale) * 100;
      return `<div class="cand ${c.id === r.lead.leader ? 'lead' : ''}" role="listitem">${pfp(c, 'pfp')}
        <div><strong>${esc(c.full_name)}</strong><small>${esc(c.title)}</small> ${outcomeTag(c)}</div>
        <div class="bar-track" role="img" aria-label="${esc(c.full_name)}: ${pct(c.vote_share)}, plus or minus ${r.moe} points">
          <div class="bar-fill" style="width:${w}%"></div><div class="whisker" style="left:${wl}%;width:${wr - wl}%"></div>
          <span class="bar-label" style="left:${Math.max(wr, 0)}%">${pct(c.vote_share)} <span class="meta">±${r.moe}</span></span></div></div>`;
    }).join('')}</div>
    ${r.undecided > 0 ? `<p class="meta">Undecided / other: ${pct(r.undecided)}</p>` : ''}
    ${r.priorities.length ? `<h3 style="font-size:20px;margin-top:26px">Voter issue priorities</h3><p class="meta">Top issue by candidate’s supporters (each bar totals 100%).</p>
      <div class="chart-box tall"><canvas id="pri-${r.id}" role="img" aria-label="Stacked bar chart of voter issue priorities by candidate supporter group; a data table follows."></canvas></div>
      <details><summary>View data table</summary>${priorityTable(r)}</details>` : ''}
  </section>`;
}

const ISSUE_COLORS = ['#184f95', '#a51c1c', '#1c6b3a', '#b7791f'];
const issuesOf = (r) => [...new Set(r.priorities.map((p) => p.issue))];
const groupsOf = (r) => r.candidates.filter((c) => r.priorities.some((p) => p.person_id === c.id));
const valOf = (r, pid, issue) => r.priorities.find((p) => p.person_id === pid && p.issue === issue)?.pct ?? 0;

function priorityTable(r) {
  return `<div class="tablewrap"><table><thead><tr><th>Supporters of</th>${issuesOf(r).map((i) => `<th class="num">${esc(i)}</th>`).join('')}</tr></thead><tbody>
    ${groupsOf(r).map((c) => `<tr><td>${esc(c.full_name)}</td>${issuesOf(r).map((i) => `<td class="num">${pct(valOf(r, c.id, i))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function drawPriorities(r) {
  const el = $(`#pri-${r.id}`); if (!el) return;
  const groups = groupsOf(r);
  charts.push(new Chart(el, {
    type: 'bar',
    data: { labels: groups.map((g) => g.full_name), datasets: issuesOf(r).map((issue, i) => ({ label: issue, data: groups.map((g) => valOf(r, g.id, issue)), backgroundColor: ISSUE_COLORS[i % 4], borderColor: '#fff', borderWidth: 1 })) },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      scales: { x: { stacked: true, max: 100, ticks: { callback: (v) => `${v}%` } }, y: { stacked: true } },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${pct(c.parsed.x)}` } },
        // In-bar value labels: the non-color channel for the segments.
        valueLabels: true,
      },
    },
    plugins: [{
      id: 'valueLabels',
      afterDatasetsDraw(chart) {
        const { ctx } = chart; ctx.save(); ctx.fillStyle = '#fff'; ctx.font = '700 12px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        chart.data.datasets.forEach((d, di) => chart.getDatasetMeta(di).data.forEach((bar, i) => { if (d.data[i] >= 7) ctx.fillText(`${d.data[i]}%`, bar.x - bar.width / 2, bar.y); }));
        ctx.restore();
      },
    }],
  }));
}

function recallHtml(r) {
  const p = r.person; const ms = r.milestone;
  return `<article class="recall"><div class="two-col"><div><h4 style="font-size:20px">${esc(p.full_name)}</h4><span class="role">${esc(p.title)} ${p.agency_code ? `· ${esc(p.agency_code)}` : ''}</span><br>
    <span class="tag">Grounds: ${esc(r.grounds)}</span>${r.filed_on ? `<span class="meta"> Filed ${fmtDate(r.filed_on)}</span>` : ''}${r.notes ? `<p class="meta">${esc(r.notes)}</p>` : ''}</div>
    <div><strong>${r.verified.toLocaleString('en-US')}</strong> of ${r.threshold.toLocaleString('en-US')} verified signatures · ${r.progress_pct}%
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${r.threshold}" aria-valuenow="${r.verified}" aria-label="Verified signatures toward threshold"><i style="width:${r.progress_pct}%"></i>${ms && ms < r.threshold ? `<b style="left:${(ms / r.threshold) * 100}%" title="Milestone ${ms}"></b>` : ''}</div>
      <span class="meta">${r.verified >= r.threshold ? '✔ Threshold reached' : `${(r.threshold - r.verified).toLocaleString('en-US')} to go`}${ms && ms < r.threshold ? ` · milestone at ${ms.toLocaleString('en-US')} ${r.verified >= ms ? '(reached)' : ''}` : ''}</span></div></div></article>`;
}

function referendumHtml(list) {
  if (!list.length) return '<p class="meta">No concluded referendums on file.</p>';
  return `<div class="tablewrap"><table><thead><tr><th>Concluded</th><th>Official</th><th>Grounds</th><th>Outcome</th><th class="num">Result</th></tr></thead><tbody>
    ${list.map((r) => `<tr><td>${fmtDate(r.concluded_on)}</td><td>${esc(r.person.full_name)}<br><span class="meta">${esc(r.person.title)}</span></td><td>${esc(r.grounds)}</td>
    <td><span class="tag ${r.outcome === 'Recalled' ? 'recalled' : ''}">${esc(r.outcome)}</span></td><td class="num">${r.result_pct != null ? pct(r.result_pct) : '–'}</td></tr>`).join('')}</tbody></table></div>`;
}

if (!location.hash) location.hash = '#/approval';
route();
