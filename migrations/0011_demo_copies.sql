-- A visitor's own copy of the Demo workspace. It expires, and a scheduled
-- job deletes the row and the repos. These rows are not counted toward the
-- limit on workspaces a team can start.

ALTER TABLE workspaces ADD COLUMN welcome_pending INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS demo_copies (
  workspace_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS demo_copies_expires ON demo_copies (expires_at);
CREATE INDEX IF NOT EXISTS demo_copies_created ON demo_copies (created_at);
