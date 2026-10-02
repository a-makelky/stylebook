-- A workspace is one team. Repos in the shared Artifacts namespace are named
-- with this id as a prefix. Email addresses are stored here and nowhere else
-- a log would copy them.

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

ALTER TABLE actors ADD COLUMN workspace_id TEXT;
ALTER TABLE actors ADD COLUMN email TEXT;
ALTER TABLE actors ADD COLUMN removed_at TEXT;

CREATE INDEX IF NOT EXISTS actors_workspace ON actors (workspace_id, kind);

-- A browser session. The cookie holds the secret. Only the hash is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- A one-time sign-in link. The secret is hashed. It expires and is single use.
CREATE TABLE IF NOT EXISTS sign_in_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  workspace_id TEXT,
  workspace_name TEXT,
  invited_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS sign_in_links_email ON sign_in_links (email, created_at);

-- Sends, so sign-in email can be limited per address and per IP.
CREATE TABLE IF NOT EXISTS sign_in_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ip TEXT NOT NULL,
  sent_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sign_in_sends_email ON sign_in_sends (email, sent_at);
CREATE INDEX IF NOT EXISTS sign_in_sends_ip ON sign_in_sends (ip, sent_at);

-- Artifacts operation counts, so usage can be read later.
CREATE TABLE IF NOT EXISTS workspace_operations (
  workspace_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, operation)
);

ALTER TABLE gateway_pushes ADD COLUMN workspace_id TEXT;
CREATE INDEX IF NOT EXISTS gateway_pushes_workspace ON gateway_pushes (workspace_id, accepted_at);
