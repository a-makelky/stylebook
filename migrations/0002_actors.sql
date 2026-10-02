-- People and agents. Keys are stored as SHA-256 hashes, never as plaintext.
-- An agent has an owner: the person it works for.

CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_id TEXT,
  model TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actor_keys (
  key_hash TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One row per ref the Git route accepted. Written by the route, not by the
-- arrival Workflow. confirmed later in push_confirmations, matched on
-- repo + ref + edition, never on time.
CREATE TABLE IF NOT EXISTS gateway_pushes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_name TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  edition_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  model TEXT,
  accepted_at TEXT NOT NULL,
  UNIQUE (repo_name, ref_name, edition_id)
);

CREATE INDEX IF NOT EXISTS gateway_pushes_edition ON gateway_pushes (edition_id);
CREATE INDEX IF NOT EXISTS gateway_pushes_accepted ON gateway_pushes (accepted_at);

CREATE TABLE IF NOT EXISTS push_confirmations (
  repo_name TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  edition_id TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY (repo_name, ref_name, edition_id)
);

-- A push event with no gateway row. A later gateway row for the same
-- repo + ref + edition means the route was slow, not that the push bypassed it.
CREATE TABLE IF NOT EXISTS unseen_pushes (
  repo_name TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  edition_id TEXT NOT NULL,
  flagged_at TEXT NOT NULL,
  PRIMARY KEY (repo_name, ref_name, edition_id)
);
