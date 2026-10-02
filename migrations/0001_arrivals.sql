-- One row per push, written by the arrival Workflow from the push event.
-- The code that runs the sessions does not write this table.

CREATE TABLE IF NOT EXISTS arrivals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_name TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  edition_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  arrived_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  detail TEXT,
  UNIQUE (repo_name, ref_name, edition_id)
);

CREATE INDEX IF NOT EXISTS arrivals_recorded_at ON arrivals (recorded_at);
