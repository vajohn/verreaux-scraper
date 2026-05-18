-- Verreaux scraper state database schema (§8)
-- Applied once on first open; idempotent via IF NOT EXISTS.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- runs: top-level run record (§8.1 + RunState)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  run_id         TEXT    PRIMARY KEY,
  series_url     TEXT    NOT NULL,
  series_id      TEXT,
  series_title   TEXT,
  source         TEXT,
  source_domain  TEXT,
  series_post_id TEXT,
  args_json      TEXT    NOT NULL,
  state          TEXT    NOT NULL,
  zip_path       TEXT,
  started_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  finished_at    TEXT,
  exit_code      INTEGER,
  validated      INTEGER NOT NULL DEFAULT 0,
  rl_budget      INTEGER NOT NULL DEFAULT 6
);

CREATE INDEX IF NOT EXISTS idx_runs_series_url ON runs (series_url);
CREATE INDEX IF NOT EXISTS idx_runs_state      ON runs (state);

-- ---------------------------------------------------------------------------
-- chapters: per-chapter progress + resume marker (§8)
-- Task names this "chapters_state" in the deliverable description but the
-- spec DDL names it "chapters". We follow the spec DDL.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chapters (
  run_id               TEXT    NOT NULL,
  chapter_number       REAL    NOT NULL,
  chapter_url          TEXT    NOT NULL,
  chapter_title        TEXT,
  selected             INTEGER NOT NULL DEFAULT 0,
  state                TEXT    NOT NULL DEFAULT 'PENDING',
  attempts             INTEGER NOT NULL DEFAULT 0,
  cf_attempts          INTEGER NOT NULL DEFAULT 0,
  verified             INTEGER NOT NULL DEFAULT 0,
  error_code           TEXT,
  error_reason         TEXT,
  expected_page_count  INTEGER,
  PRIMARY KEY (run_id, chapter_number),
  FOREIGN KEY (run_id) REFERENCES runs (run_id)
);

CREATE INDEX IF NOT EXISTS idx_chapters_run_id ON chapters (run_id);
CREATE INDEX IF NOT EXISTS idx_chapters_state  ON chapters (run_id, state);

-- ---------------------------------------------------------------------------
-- pages: per-page progress + resume marker (§8)
-- Task names this "pages_state" in the deliverable description; spec DDL
-- names it "pages". We follow the spec DDL.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pages (
  run_id          TEXT    NOT NULL,
  chapter_number  REAL    NOT NULL,
  page_index      INTEGER NOT NULL,
  image_url       TEXT    NOT NULL,
  referer         TEXT    NOT NULL,
  sha1            TEXT,
  bytes           INTEGER,
  ext             TEXT,
  tmp_path        TEXT,
  state           TEXT    NOT NULL DEFAULT 'PENDING',
  attempts        INTEGER NOT NULL DEFAULT 0,
  error_code      TEXT,
  error_reason    TEXT,
  PRIMARY KEY (run_id, chapter_number, page_index),
  FOREIGN KEY (run_id) REFERENCES runs (run_id)
);

CREATE INDEX IF NOT EXISTS idx_pages_run_chapter ON pages (run_id, chapter_number);

-- ---------------------------------------------------------------------------
-- cookies: harvested CF clearances + jar (§8 + CookieRecord)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cookies (
  host        TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  value       TEXT    NOT NULL,
  domain      TEXT    NOT NULL,
  path        TEXT    NOT NULL,
  expires     INTEGER,
  user_agent  TEXT    NOT NULL,
  fetched_at  TEXT    NOT NULL,
  last_used   TEXT,
  stale       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (host, name)
);

CREATE INDEX IF NOT EXISTS idx_cookies_domain ON cookies (domain);

-- ---------------------------------------------------------------------------
-- image_hashes: global SHA-1 dedup cache (§8.4 + ImageHash)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS image_hashes (
  sha1          TEXT    PRIMARY KEY,
  byte_length   INTEGER NOT NULL,
  mime          TEXT    NOT NULL,
  first_seen_at TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- run_events: append-only event log (§13)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT    NOT NULL,
  ts           TEXT    NOT NULL,
  event        TEXT    NOT NULL,
  payload_json TEXT    NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs (run_id)
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events (run_id);
