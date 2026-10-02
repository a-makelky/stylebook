-- A person can set a suggestion aside on the review screen. The copy stays.

CREATE TABLE IF NOT EXISTS declines (
  actor_id TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  path TEXT NOT NULL,
  declined_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, repo_name, path)
);
