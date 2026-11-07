DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM transfers WHERE status='pending') THEN
  RAISE EXCEPTION 'legacy pending transfers must finish before Stage 8 upgrade';
 END IF;
END $$;
ALTER TABLE visits ADD COLUMN schedule_generation integer NOT NULL DEFAULT 1 CHECK(schedule_generation>0);
ALTER TABLE transfers ADD COLUMN initiator_user_id uuid REFERENCES telegram_users(id);
ALTER TABLE transfers ADD COLUMN context jsonb;
ALTER TABLE transfers ADD CONSTRAINT transfer_pending_context CHECK(status<>'pending' OR
 (initiator_user_id IS NOT NULL AND context IS NOT NULL AND jsonb_typeof(context)='object'
  AND context ?& ARRAY['visitVersion','clientId','clientUserId','barberId','oldStart','oldEnd','scheduleGeneration']
  AND jsonb_typeof(context->'visitVersion')='number' AND jsonb_typeof(context->'scheduleGeneration')='number'
  AND (context->>'visitVersion')::integer>0 AND (context->>'scheduleGeneration')::integer>0
  AND jsonb_typeof(context->'clientId')='string' AND jsonb_typeof(context->'barberId')='string'
  AND jsonb_typeof(context->'oldStart')='string' AND jsonb_typeof(context->'oldEnd')='string'));
CREATE TABLE transfer_callbacks(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES telegram_users(id),
 transfer_id uuid NOT NULL REFERENCES transfers(id),transfer_version integer NOT NULL CHECK(transfer_version>0),
 action text NOT NULL CHECK(action IN ('accept','decline','phone')),expires_at timestamptz NOT NULL,consumed_at timestamptz
);
CREATE INDEX transfer_callbacks_entity ON transfer_callbacks(transfer_id) WHERE consumed_at IS NULL;
