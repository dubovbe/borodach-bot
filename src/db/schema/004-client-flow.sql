CREATE TABLE staff_callbacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES telegram_users(id),
  visit_id uuid NOT NULL REFERENCES visits(id), visit_version integer NOT NULL CHECK(visit_version>0),
  action text NOT NULL CHECK(action IN ('confirmBooking','declineBooking')),
  expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE INDEX staff_callbacks_visit ON staff_callbacks(visit_id);
ALTER TABLE outbox ADD COLUMN draft_id uuid REFERENCES drafts(id);
ALTER TABLE outbox ADD COLUMN draft_version integer CHECK(draft_version>0);
ALTER TABLE outbox ADD CONSTRAINT outbox_draft_scope CHECK (
  (draft_id IS NULL AND draft_version IS NULL AND kind<>'client_screen') OR
  (draft_id IS NOT NULL AND draft_version IS NOT NULL AND kind='client_screen' AND entity_id IS NULL AND entity_version IS NULL AND entity_type IS NULL)
);
CREATE INDEX outbox_draft_pending ON outbox(draft_id) WHERE status IN ('pending','leased');
