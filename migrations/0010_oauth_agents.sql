-- One row per dynamic client registration, so one network cannot register without limit.
CREATE TABLE IF NOT EXISTS oauth_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  sent_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_registrations_ip ON oauth_registrations (ip, sent_at);

-- The same signed-in app reconnects to the agent it already created.
-- A different app, or a key made by hand, is a different agent.
CREATE TABLE IF NOT EXISTS oauth_agents (
  client_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  PRIMARY KEY (client_id, owner_id, workspace_id)
);
