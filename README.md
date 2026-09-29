# Harrison Polling Institute (HPI) platform

Public tracker (approval hub, trend charts, election & recall forecast) plus an authenticated admin dashboard that is the **single source of truth** for everything the public site shows.

**Stack:** Node 20+ / Express 5 + SQLite (`better-sqlite3`) API, `sharp` for image processing (circular PFPs, thumbnails, summary-card PNG), and a dependency-light vanilla ES-module front-end with Chart.js (served locally, no CDN). Chosen so `npm install && npm start` is the whole setup: no build step, no external database.

## Run

```bash
npm install
cp .env.example .env      # optional; set ADMIN_PASSWORD
npm start                 # http://localhost:3000  (admin: /admin/)
npm test                  # badge thresholds, net score, MoE, aggregation, validation
```

First start creates the database in `data/`, seeds demo data, and creates the admin user (`admin` / `ADMIN_PASSWORD`, or a random password printed once in the console).
`npm run reseed` wipes and reseeds data (users kept). `npm run passwd -- <user> <new-password>` resets a password.
For production set `NODE_ENV=production` (secure cookies) and serve behind HTTPS.

## Structure

```
src/lib/stats.js        ALL derived logic: net score, MoE, badges, weekly/monthly aggregation, race lead
src/lib/validate.js     poll/input validation
src/server/             config, db (schema), auth, images, queries, seed, index (app)
src/server/routes/      public.js (read-only API), admin.js (all writes), media.js (card, press, export)
public/                 index.html + js/app.js (public site), admin/ (dashboard), styles.css
test/stats.test.js
```

## Schema (SQLite, `src/server/db.js`)
`users`, `sessions`, `agencies`, `people` (category, archived_at, outcome_badge, pfp/thumb paths), `polls` (raw survey inputs only), `poll_history` (audit log, no FK so it survives deletes), `races`, `race_candidates`, `race_priorities`, `recalls` (status active/archived).
Net, approve/disapprove totals, MoE and badges are **never stored or entered** — always computed from raw rows by `stats.js`.

## Decisions & documented choices
- **MoE:** `±1.96 × √(0.25 / n) × 100`, 95% confidence, worst case p = 0.5, no finite-population correction. Not overridable. Weekly/monthly points pool n (sample-size-weighted percentages) and recompute MoE. Race MoE is admin-entered per the brief.
- **Badges** (Δ = latest net − previous poll's net, rounded to 0.1): 🟢▲ Rising Δ ≥ +3.0; 🔴▼ Falling Δ ≤ −3.0; ⚪▬ Steady |Δ| ≤ 1.0; **between 1.0 and 3.0 → neutral gray “△ Edging Up / ▽ Edging Down”**; “New” with no prior poll; “Stale” if the last poll is over 90 days old. Every badge has a glyph and text, not just color.
- **Poll totals:** must be 100 ± 0.5; a larger gap is rejected unless the row's “save despite mismatch” box is ticked (stored with a ⚠ flag). Batches are all-or-nothing.
- **Issue priorities** are per-candidate-supporter groups (each totalling 100%), drawn as a stacked bar.
- **Race lead** is “outside the margin” only when the gap exceeds 2× MoE.
- **Recalls/races:** archiving a recall with outcome *Recalled* sets the Recalled badge; concluding a race sets *Succeeded* on the winner. Neither archives anyone — admins do that manually (Archive tab, searchable).
- **Auth:** scrypt password hashes, random session tokens (hashed in DB), HttpOnly SameSite=Strict cookies, `requireAdmin` on every `/api/admin` route, a custom header required on writes, login throttling. Roster deletion requires typing the person's name. Remote PFP URLs are fetched with SSRF/size/timeout guards.
- Seed names other than the four DA candidates and “Francis” are fictional placeholders. Candidate-category people appear only in the forecast, not the approval grid.
- Styling: ROSPAN H-SPAN blue/red diverging palette and navy brand; The Harrison Independent's rules, serif headlines and section heads.
