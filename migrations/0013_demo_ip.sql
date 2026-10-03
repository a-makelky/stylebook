-- The visitor's network, so one address cannot open every copy for the day.
-- Only the connecting address is stored. A forwarded header is not a fallback.

ALTER TABLE demo_copies ADD COLUMN ip TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS demo_copies_ip_created ON demo_copies (ip, created_at);
