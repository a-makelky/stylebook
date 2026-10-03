-- Who took a service-admin action. The address is stored only as a hash.
ALTER TABLE service_audit ADD COLUMN actor_hash TEXT;
