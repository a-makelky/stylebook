-- The version a tool reported when it connected. The tool name stays in model.
ALTER TABLE actors ADD COLUMN client_version TEXT;
