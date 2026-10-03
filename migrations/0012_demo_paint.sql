-- The first page of a demo copy, drawn while the copy was being made, so the
-- visitor's next request does not read it all again. Cleared after it is shown.

ALTER TABLE demo_copies ADD COLUMN paint TEXT;
