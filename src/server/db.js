import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agencies (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  handle TEXT,
  title TEXT NOT NULL,
  agency_id INTEGER REFERENCES agencies(id) ON DELETE SET NULL,
  category TEXT NOT NULL CHECK (category IN ('constitutional','department','candidate')),
  pfp_path TEXT,
  thumb_path TEXT,
  outcome_badge TEXT NOT NULL DEFAULT '' CHECK (outcome_badge IN ('','recalled','succeeded')),
  archived_at TEXT,
  archive_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_people_archived ON people(archived_at);
-- Only raw survey inputs are stored. Approve/disapprove/net/MoE are always derived (src/lib/stats.js).
CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  survey_start TEXT NOT NULL,
  survey_end TEXT NOT NULL,
  sample_size INTEGER NOT NULL CHECK (sample_size > 0),
  strong_approve REAL NOT NULL, some_approve REAL NOT NULL,
  some_disapprove REAL NOT NULL, strong_disapprove REAL NOT NULL, neutral REAL NOT NULL,
  total_flagged INTEGER NOT NULL DEFAULT 0,
  event_note TEXT,
  created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_polls_person ON polls(person_id, survey_end);
-- No FK: history must outlive deleted polls/people.
CREATE TABLE IF NOT EXISTS poll_history (
  id INTEGER PRIMARY KEY,
  poll_id INTEGER NOT NULL,
  person_id INTEGER NOT NULL,
  person_name TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  changed_by TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('create','update','delete')),
  prior_values TEXT,
  new_values TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_poll ON poll_history(poll_id);
CREATE TABLE IF NOT EXISTS races (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  moe REAL NOT NULL DEFAULT 0,
  turnout_min INTEGER, turnout_max INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','concluded')),
  winner_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS race_candidates (
  race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  vote_share REAL NOT NULL,
  PRIMARY KEY (race_id, person_id)
);
-- Issue priorities per candidate's supporter group; each group's issues sum to 100.
CREATE TABLE IF NOT EXISTS race_priorities (
  race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  issue TEXT NOT NULL,
  pct REAL NOT NULL,
  PRIMARY KEY (race_id, person_id, issue)
);
CREATE TABLE IF NOT EXISTS recalls (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  grounds TEXT NOT NULL,
  threshold INTEGER NOT NULL CHECK (threshold > 0),
  milestone INTEGER,
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified >= 0),
  filed_on TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  outcome TEXT, result_pct REAL, concluded_on TEXT, notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
