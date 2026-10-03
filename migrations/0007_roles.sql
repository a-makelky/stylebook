-- Admin and Member. The person who started the workspace is an Admin.
ALTER TABLE actors ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
ALTER TABLE actors ADD COLUMN last_used_at TEXT;

UPDATE actors
SET role = 'admin'
WHERE kind = 'person'
  AND id IN (SELECT owner_id FROM workspaces WHERE owner_id IS NOT NULL);

-- Off until an Admin turns it on.
ALTER TABLE workspaces ADD COLUMN members_can_publish INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN deleted_at TEXT;
ALTER TABLE workspaces ADD COLUMN limit_people INTEGER;
ALTER TABLE workspaces ADD COLUMN limit_agents INTEGER;
ALTER TABLE workspaces ADD COLUMN limit_suggestions INTEGER;

-- Waiting for that email to sign in. Not a message that has been sent.
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cancelled_at TEXT,
  accepted_at TEXT
);

CREATE INDEX IF NOT EXISTS invitations_email ON invitations (email, workspace_id);

-- A page an Admin has locked. Suggestions stay open. Only an Admin publishes it.
CREATE TABLE IF NOT EXISTS locked_pages (
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  locked_by TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, path)
);

-- One row per person per month. The address is stored only as a hash.
CREATE TABLE IF NOT EXISTS sign_ins (
  email_hash TEXT NOT NULL,
  month TEXT NOT NULL,
  PRIMARY KEY (email_hash, month)
);

-- Service-admin actions. No names or email addresses.
CREATE TABLE IF NOT EXISTS service_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  detail TEXT NOT NULL
);

-- Operation counts for one calendar month, for the service-admin estimate.
CREATE TABLE IF NOT EXISTS workspace_operation_months (
  workspace_id TEXT NOT NULL,
  month TEXT NOT NULL,
  operation TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, month, operation)
);
