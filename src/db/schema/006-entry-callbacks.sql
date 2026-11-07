CREATE TABLE entry_callbacks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES telegram_users(id),
 visit_id uuid NOT NULL REFERENCES visits(id),
 visit_version integer NOT NULL CHECK (visit_version > 0),
 action text NOT NULL CHECK (action = 'new_booking'),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz
);
CREATE INDEX entry_callbacks_visit ON entry_callbacks(visit_id) WHERE consumed_at IS NULL;
