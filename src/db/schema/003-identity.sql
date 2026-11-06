-- Expand-only: historical invitations remain valid database rows, but cannot be rendered without their issuer.
ALTER TABLE invitations ADD COLUMN issued_by uuid REFERENCES telegram_users(id);
CREATE INDEX invitations_barber_open ON invitations(barber_id) WHERE used_at IS NULL AND revoked_at IS NULL;
