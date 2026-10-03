-- Downloads, mirrors and restores. Names only: no email addresses and no secrets.
CREATE TABLE IF NOT EXISTS workspace_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS workspace_audit_workspace ON workspace_audit (workspace_id, id);

-- One GitHub backup and one other-service backup per workspace.
-- token_cipher is the other service's secret, encrypted. GitHub stores an
-- installation id and mints a short-lived token per send.
CREATE TABLE IF NOT EXISTS backup_mirrors (
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  address TEXT NOT NULL,
  token_cipher TEXT,
  github_installation_id TEXT,
  login TEXT,
  keep_current INTEGER NOT NULL DEFAULT 0,
  last_ok_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, kind)
);

-- One-time state for GitHub's install screen. The secret is stored as a hash.
CREATE TABLE IF NOT EXISTS backup_states (
  state_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
