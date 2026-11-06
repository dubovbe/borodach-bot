ALTER TABLE telegram_users ADD COLUMN unreachable_at timestamptz;
ALTER TABLE audit_events ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE audit_events ALTER COLUMN update_id DROP NOT NULL;
ALTER TABLE audit_events ADD COLUMN source text NOT NULL DEFAULT 'user';
ALTER TABLE audit_events ADD CONSTRAINT audit_source_actor CHECK ((source='user' AND actor_id IS NOT NULL AND update_id IS NOT NULL) OR (source='system' AND actor_id IS NULL AND update_id IS NULL));
ALTER TABLE outbox ALTER COLUMN update_id DROP NOT NULL;
ALTER TABLE outbox ADD COLUMN status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','sent','failed','cancelled'));
ALTER TABLE outbox ADD COLUMN entity_id uuid;
ALTER TABLE outbox ADD COLUMN entity_version integer CHECK(entity_version>0);
ALTER TABLE outbox ADD COLUMN entity_type text CHECK(entity_type IN ('visit','transfer'));
ALTER TABLE outbox ADD COLUMN claim_token uuid;
ALTER TABLE outbox ADD COLUMN last_error text CHECK(last_error IN ('transient','timeout','rate_limited','unreachable','permanent','invalid_payload','stale_entity','unknown_kind'));
ALTER TABLE outbox ADD COLUMN message_id text;
UPDATE outbox SET status='sent' WHERE sent_at IS NOT NULL;
-- Legacy booking events refer to a visit. Capture the only safely reconstructable version.
UPDATE outbox o SET entity_id=v.id,entity_version=v.version,entity_type='visit'
FROM visits v WHERE o.kind='booking' AND o.payload->>'visitId'=v.id::text;
UPDATE outbox SET status='failed',last_error='invalid_payload' WHERE status='pending' AND kind='booking' AND entity_id IS NULL;
DROP INDEX outbox_due;
DROP INDEX outbox_update_pending;
CREATE INDEX outbox_due ON outbox(due_at) WHERE status='pending';
CREATE INDEX outbox_leases ON outbox(lease_until) WHERE status='leased';
CREATE INDEX outbox_update_pending ON outbox(update_id) WHERE status IN ('pending','leased');
CREATE INDEX outbox_entity_pending ON outbox(entity_id) WHERE status IN ('pending','leased');
CREATE INDEX jobs_leases ON jobs(lease_until) WHERE status='leased';
