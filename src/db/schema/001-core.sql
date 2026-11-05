CREATE TABLE shop (
  id integer PRIMARY KEY CHECK (id = 1), name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Europe/Moscow' CHECK (timezone = 'Europe/Moscow'),
  address text NOT NULL, version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id integer NOT NULL UNIQUE REFERENCES shop(id),
  booking_horizon_days integer NOT NULL DEFAULT 30 CHECK (booking_horizon_days > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE telegram_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), telegram_id bigint NOT NULL UNIQUE,
  first_name text, last_seen_at timestamptz NOT NULL, version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES telegram_users(id),
  role text NOT NULL CHECK (role IN ('client','barber','admin')), UNIQUE(user_id, role)
);
CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE REFERENCES telegram_users(id),
  name text NOT NULL, phone text, reminder_hours integer NOT NULL DEFAULT 2 CHECK (reminder_hours BETWEEN 1 AND 5),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE phone_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL REFERENCES clients(id),
  user_id uuid NOT NULL REFERENCES telegram_users(id), phone text NOT NULL, claimed_at timestamptz NOT NULL,
  released_at timestamptz, CHECK (released_at IS NULL OR released_at >= claimed_at)
);
CREATE UNIQUE INDEX phone_claims_active_phone ON phone_claims(phone) WHERE released_at IS NULL;
CREATE UNIQUE INDEX phone_claims_active_client ON phone_claims(client_id) WHERE released_at IS NULL;
CREATE TABLE ranks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, archived_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE barbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE REFERENCES telegram_users(id),
  rank_id uuid REFERENCES ranks(id), name text NOT NULL, public_token_hash text UNIQUE,
  archived_at timestamptz, version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, archived_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE rank_tariffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rank_id uuid NOT NULL REFERENCES ranks(id),
  service_id uuid NOT NULL REFERENCES services(id), price_kopecks integer NOT NULL CHECK (price_kopecks >= 0),
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), UNIQUE(rank_id,service_id)
);
CREATE TABLE barber_tariffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), barber_id uuid NOT NULL REFERENCES barbers(id),
  service_id uuid NOT NULL REFERENCES services(id), price_kopecks integer NOT NULL CHECK (price_kopecks >= 0),
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), UNIQUE(barber_id,service_id)
);
CREATE TABLE assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), barber_id uuid NOT NULL REFERENCES barbers(id),
  service_id uuid NOT NULL REFERENCES services(id), version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE(barber_id,service_id)
);
CREATE TABLE weekly_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), barber_id uuid NOT NULL REFERENCES barbers(id),
  weekday integer NOT NULL CHECK (weekday BETWEEN 1 AND 7), start_minute integer NOT NULL CHECK (start_minute >= 0),
  end_minute integer NOT NULL CHECK (end_minute <= 1440), CHECK (start_minute < end_minute),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), UNIQUE(barber_id,weekday,start_minute)
);
-- An empty JSON array explicitly represents a day off. Interval elements are validated by Stage3 service.
CREATE TABLE date_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), barber_id uuid NOT NULL REFERENCES barbers(id), local_date date NOT NULL,
  intervals jsonb NOT NULL CHECK (jsonb_typeof(intervals) = 'array'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), UNIQUE(barber_id,local_date)
);
CREATE TABLE visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL REFERENCES clients(id),
  barber_id uuid NOT NULL REFERENCES barbers(id), status text NOT NULL
    CHECK (status IN ('pending','confirmed','declined','expired','cancelled','completed','no_show')),
  start_at timestamptz NOT NULL, end_at timestamptz NOT NULL CHECK (start_at < end_at),
  deadline timestamptz, created_at timestamptz NOT NULL, version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX visits_barber_overlap ON visits(barber_id,start_at,end_at) WHERE status IN ('pending','confirmed');
CREATE INDEX visits_client_future ON visits(client_id,start_at);
CREATE TABLE visit_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), visit_id uuid NOT NULL REFERENCES visits(id),
  service_id uuid NOT NULL REFERENCES services(id), name text NOT NULL,
  price_kopecks integer NOT NULL CHECK (price_kopecks >= 0), duration_minutes integer NOT NULL CHECK (duration_minutes > 0)
);
CREATE TABLE transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), visit_id uuid NOT NULL REFERENCES visits(id),
  initiator text NOT NULL CHECK (initiator IN ('client','staff')),
  status text NOT NULL CHECK (status IN ('pending','accepted','declined','expired','cancelled')),
  new_start_at timestamptz NOT NULL, new_end_at timestamptz NOT NULL CHECK (new_start_at < new_end_at),
  deadline timestamptz NOT NULL, reason text, agreed_by uuid REFERENCES telegram_users(id),
  agreed_at timestamptz, agreement_channel text CHECK (agreement_channel IN ('telegram','phone')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX transfers_one_pending ON transfers(visit_id) WHERE status = 'pending';
CREATE TABLE holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), visit_id uuid NOT NULL REFERENCES visits(id),
  transfer_id uuid UNIQUE REFERENCES transfers(id), barber_id uuid NOT NULL REFERENCES barbers(id),
  kind text NOT NULL CHECK (kind IN ('visit','transfer')), start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL CHECK (start_at < end_at), expires_at timestamptz,
  CHECK ((kind='transfer' AND transfer_id IS NOT NULL) OR (kind='visit' AND transfer_id IS NULL)),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
-- No exclusion constraint: a transfer may overlap the old hold of the SAME visit.
CREATE INDEX holds_barber_overlap ON holds(barber_id,start_at,end_at);
CREATE INDEX holds_expiry ON holds(expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE REFERENCES telegram_users(id),
  barber_id uuid REFERENCES barbers(id), state jsonb NOT NULL DEFAULT '{}', expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE callbacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES telegram_users(id),
  draft_id uuid NOT NULL REFERENCES drafts(id), draft_version integer NOT NULL CHECK (draft_version > 0),
  action jsonb NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), barber_id uuid NOT NULL REFERENCES barbers(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL, used_by uuid REFERENCES telegram_users(id), used_at timestamptz, revoked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE processed_updates (
  update_id bigint PRIMARY KEY, actor_telegram_id bigint NOT NULL REFERENCES telegram_users(telegram_id),
  result jsonb NOT NULL, processed_at timestamptz NOT NULL
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), update_id bigint NOT NULL,
  actor_id uuid NOT NULL REFERENCES telegram_users(id), kind text NOT NULL, entity_id uuid,
  data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL
);
CREATE INDEX audit_update ON audit_events(update_id);
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), logical_key text NOT NULL UNIQUE,
  kind text NOT NULL, visit_id uuid REFERENCES visits(id), entity_version integer NOT NULL CHECK (entity_version > 0),
  due_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','done','cancelled')),
  payload jsonb NOT NULL DEFAULT '{}', lease_until timestamptz, attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX jobs_due ON jobs(due_at) WHERE status IN ('pending','leased');
CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), logical_key text NOT NULL UNIQUE, update_id bigint NOT NULL,
  kind text NOT NULL, chat_id bigint NOT NULL, payload jsonb NOT NULL, due_at timestamptz NOT NULL,
  sent_at timestamptz, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX outbox_due ON outbox(due_at) WHERE sent_at IS NULL;
CREATE INDEX outbox_update_pending ON outbox(update_id) WHERE sent_at IS NULL;
