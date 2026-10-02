-- The person who started a workspace. Only they can remove people.
ALTER TABLE workspaces ADD COLUMN owner_id TEXT;

UPDATE workspaces
SET owner_id = (
  SELECT a.id FROM actors a
  WHERE a.workspace_id = workspaces.id AND a.kind = 'person' AND a.removed_at IS NULL
  ORDER BY a.created_at, a.id
  LIMIT 1
)
WHERE owner_id IS NULL;

-- The Demo workspace's person was named Demo. The name is Editor.
-- Suggestion lines read the name stored with the edition, so that copy changes too.
UPDATE actors
SET name = 'Editor'
WHERE kind = 'person'
  AND name = 'Demo'
  AND removed_at IS NULL
  AND workspace_id IN (SELECT id FROM workspaces WHERE name = 'Demo');

UPDATE gateway_pushes
SET owner_name = 'Editor'
WHERE owner_name = 'Demo'
  AND workspace_id IN (SELECT id FROM workspaces WHERE name = 'Demo');

UPDATE gateway_pushes
SET actor_name = 'Editor'
WHERE actor_name = 'Demo'
  AND actor_kind = 'person'
  AND workspace_id IN (SELECT id FROM workspaces WHERE name = 'Demo');

-- One row per workspace a person asked to start. The insert is the cap.
CREATE TABLE IF NOT EXISTS workspace_starts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ip TEXT NOT NULL,
  started_at TEXT NOT NULL,
  workspace_id TEXT
);

CREATE INDEX IF NOT EXISTS workspace_starts_email ON workspace_starts (email);
CREATE INDEX IF NOT EXISTS workspace_starts_ip ON workspace_starts (ip, started_at);
