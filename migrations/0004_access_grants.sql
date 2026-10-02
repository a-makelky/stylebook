-- Short-lived credentials the Git route accepts in place of a Stylebook key.
-- The plaintext is returned once to the caller. Only the hash is stored.

CREATE TABLE IF NOT EXISTS access_grants (
  token_hash TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  can_write INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
