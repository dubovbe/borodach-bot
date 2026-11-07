import {cancelLinkedTransfers} from '../booking/transfers';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { DomainError, type Actor, type Id } from '../domain/types';
import type { Tx } from '../db/client';

export type IdentityOptions = { invitationSecret?: string; botUsername?: string };
const deny = (code = 'forbidden'): never => { throw new DomainError(code, 'Действие недоступно. Обновите данные.'); };
export function isMeaningfulName(text:string):boolean{return text.trim().length>=1&&text.trim().length<=80&&!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text);}
export function normalizePhone(value: string, telegram = false): string {
  if (typeof value !== 'string' || value.length > 40 || !/^[+\d\s().-]+$/.test(value)) deny('invalid_phone');
  const input = telegram && /^\d+$/.test(value) ? `+${value}` : value;
  const parsed = parsePhoneNumberFromString(input, 'RU');
  if (!parsed || parsed.ext || !parsed.isValid()) return deny('invalid_phone');
  return parsed.number;
}
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export async function invitationToken(id: Id, secret?: string): Promise<string> {
  if (!secret || secret.length < 32 || !secret.trim() || new Set(secret).size < 8) deny('invitation_unconfigured');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`borodach:barber-invitation:v1:${id}`)));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function acceptContact(actor: Actor, contact: { userId?: Id; phone: string }, tx: Tx): Promise<Id> {
  if (!contact.userId || contact.userId !== actor.telegramId) deny('invalid_contact');
  const phone = normalizePhone(contact.phone, true);
  const user = (await tx.query<{ id: Id; first_contact: boolean }>(`SELECT u.id,NOT EXISTS(SELECT 1 FROM phone_claims p WHERE p.user_id=u.id) AS first_contact FROM telegram_users u WHERE telegram_id=$1`, [actor.telegramId]))[0];
  if (!user) deny();
  // Check the competing owner before changing either the old claim or the client profile.
  const collision = await tx.query<{ user_id: Id }>('SELECT user_id FROM phone_claims WHERE phone=$1 AND released_at IS NULL', [phone]);
  if (collision.some(c => c.user_id !== user.id)) deny('phone_in_use');
  const client = (await tx.query<{ id: Id }>(`INSERT INTO clients(user_id,name,phone) VALUES($1,'',$2)
    ON CONFLICT(user_id) DO UPDATE SET phone=EXCLUDED.phone,version=CASE WHEN clients.phone IS DISTINCT FROM EXCLUDED.phone THEN clients.version+1 ELSE clients.version END RETURNING id`, [user.id, phone]))[0];
  await tx.query(`WITH released AS (
    UPDATE phone_claims SET released_at=$3 WHERE user_id=$1 AND released_at IS NULL AND phone<>$2 RETURNING id
  ) INSERT INTO phone_claims(client_id,user_id,phone,claimed_at)
    SELECT $4,$1,$2,$3 WHERE (SELECT count(*) FROM released)>=0
      AND NOT EXISTS(SELECT 1 FROM phone_claims WHERE user_id=$1 AND phone=$2 AND released_at IS NULL)`, [user.id, phone, tx.now, client.id]);
  await tx.query("INSERT INTO roles(user_id,role) VALUES($1,'client') ON CONFLICT(user_id,role) DO NOTHING", [user.id]);
  if (user.first_contact) {
    // Reassign visits, never the manual client's identity: past visits remain inaccessible.
    const moved = await tx.query<{ id: Id }>(`UPDATE visits v SET client_id=$1,version=v.version+1 FROM clients c
      WHERE v.client_id=c.id AND c.user_id IS NULL AND c.phone=$2 AND v.status='confirmed' AND v.start_at>$3 RETURNING v.id`, [client.id, phone, tx.now]);
    if (moved.length) {
      const ids = moved.map(v => v.id);
      await cancelLinkedTransfers(tx,ids);
      // Outstanding jobs keep their due dates but follow the new ownership version.
      await tx.query(`UPDATE jobs j SET entity_version=v.version,version=j.version+1 FROM visits v
        WHERE j.visit_id=v.id AND v.id=ANY($1::uuid[]) AND j.kind<>'expire_transfer' AND j.status IN ('pending','leased')`, [ids]);
      await tx.query(`UPDATE outbox SET status='cancelled',claim_token=NULL,lease_until=NULL,version=version+1
        WHERE status IN ('pending','leased') AND entity_id=ANY($1::uuid[])`, [ids]);
    }
  }
  return client.id;
}

// Public availability is intentionally a separate read API. Unknown actions always fail closed.
const actions: Record<string, 'admin' | 'barber' | 'client'> = {
  issueBarberInvite: 'admin', revokeInvite: 'admin', changeSchedule: 'admin',
  readBarberProfile: 'barber', readBarberAppointments: 'barber', readStatistics: 'barber',
  readClientProfile: 'client', updateClientProfile: 'client', readClientBookings: 'client',
};
export async function requirePermission(actor: Actor, action: string, resource: { barberId?: Id; clientId?: Id }, tx: Tx): Promise<void> {
  const scope = Object.hasOwn(actions, action) ? actions[action] : undefined;
  if (!scope) return deny();
  if ((scope !== 'client' && !resource.barberId) || (scope === 'client' && !resource.clientId)) deny();
  const row = (await tx.query<{ admin: boolean; barber: boolean; client: boolean; barber_ok: boolean; client_ok: boolean; related: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM roles WHERE user_id=u.id AND role='admin') AS admin,
    EXISTS(SELECT 1 FROM roles WHERE user_id=u.id AND role='barber') AS barber,
    EXISTS(SELECT 1 FROM roles WHERE user_id=u.id AND role='client') AS client,
    EXISTS(SELECT 1 FROM barbers WHERE id::text=$2 AND archived_at IS NULL AND (user_id=u.id OR EXISTS(SELECT 1 FROM roles WHERE user_id=u.id AND role='admin'))) AS barber_ok,
    EXISTS(SELECT 1 FROM clients WHERE id::text=$3 AND (user_id=u.id OR EXISTS(SELECT 1 FROM roles WHERE user_id=u.id AND role='admin'))) AS client_ok,
    EXISTS(SELECT 1 FROM visits WHERE barber_id::text=$2 AND client_id::text=$3) AS related
    FROM telegram_users u WHERE telegram_id=$1`, [actor.telegramId, resource.barberId ?? null, resource.clientId ?? null]))[0];
  if (!row || (scope === 'admin' && !row.admin) || (!row.admin && !row[scope]) ||
    (resource.barberId && !row.barber_ok) || (resource.clientId && !row.client_ok) ||
    (resource.barberId && resource.clientId && !row.related)) deny();
}

export async function issueBarberInvite(actor: Actor, barberId: Id, tx: Tx, options: IdentityOptions): Promise<Id> {
  await requirePermission(actor, 'issueBarberInvite', { barberId }, tx);
  const barber = (await tx.query<{ id: Id }>(`SELECT id FROM barbers WHERE id::text=$1 AND user_id IS NULL AND archived_at IS NULL`, [barberId]))[0];
  if (!barber) deny('invite_invalid');
  if (!options.botUsername || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(options.botUsername)) deny('invitation_unconfigured');
  const id = crypto.randomUUID();
  const token = await invitationToken(id, options.invitationSecret);
  const hash = await hashToken(token);
  await tx.query(`WITH revoked AS (
    UPDATE invitations SET revoked_at=$2,version=version+1
    WHERE barber_id=$1 AND used_at IS NULL AND revoked_at IS NULL RETURNING id
  ) UPDATE outbox SET status='cancelled',claim_token=NULL,lease_until=NULL,version=version+1
    WHERE kind='invitation' AND status IN ('pending','leased')
      AND payload->>'invitationId' IN (SELECT id::text FROM revoked)`, [barberId, tx.now]);
  await tx.query(`INSERT INTO invitations(id,barber_id,token_hash,expires_at,issued_by)
    SELECT $1,$2,$3,$4::timestamptz+interval '24 hours',id FROM telegram_users WHERE telegram_id=$5`, [id, barberId, hash, tx.now, actor.telegramId]);
  return id;
}
export async function revokeInvite(actor: Actor, invitationId: Id, tx: Tx): Promise<Id> {
  // Check admin before exposing whether a specific invitation exists.
  const admin = await tx.query(`SELECT 1 FROM roles r JOIN telegram_users u ON u.id=r.user_id WHERE u.telegram_id=$1 AND r.role='admin'`, [actor.telegramId]);
  if (!admin.length) deny();
  const invitation = (await tx.query<{ barber_id: Id }>('SELECT barber_id FROM invitations WHERE id::text=$1', [invitationId]))[0];
  if (!invitation) deny('invite_invalid');
  await requirePermission(actor, 'revokeInvite', { barberId: invitation.barber_id }, tx);
  await tx.query(`WITH revoked AS (
    UPDATE invitations SET revoked_at=COALESCE(revoked_at,$2),version=version+1
    WHERE id=$1 AND used_at IS NULL RETURNING id
  ) UPDATE outbox SET status='cancelled',claim_token=NULL,lease_until=NULL,version=version+1
    WHERE kind='invitation' AND status IN ('pending','leased')
      AND payload->>'invitationId' IN (SELECT id::text FROM revoked)`, [invitationId, tx.now]);
  return invitationId;
}
export async function redeemInvite(actor: Actor, token: string, tx: Tx): Promise<Id> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) deny('invite_invalid');
  const hash = await hashToken(token);
  const result = await tx.query<{ barber_id: Id }>(`WITH candidate AS (
    SELECT i.id,i.barber_id,u.id user_id FROM invitations i JOIN barbers b ON b.id=i.barber_id CROSS JOIN telegram_users u
    WHERE i.token_hash=$1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>$2
      AND b.archived_at IS NULL AND b.user_id IS NULL AND u.telegram_id=$3
      AND NOT EXISTS(SELECT 1 FROM barbers other WHERE other.user_id=u.id)
  ), bound AS (
    UPDATE barbers b SET user_id=c.user_id,version=b.version+1 FROM candidate c WHERE b.id=c.barber_id RETURNING b.id,b.user_id
  ), granted AS (
    INSERT INTO roles(user_id,role) SELECT user_id,'barber' FROM bound ON CONFLICT(user_id,role) DO NOTHING
  ), consumed AS (
    UPDATE invitations i SET used_by=c.user_id,used_at=$2,version=i.version+1 FROM candidate c JOIN bound b ON b.id=c.barber_id
    WHERE i.id=c.id RETURNING i.id,i.barber_id
  ), cancelled AS (
    UPDATE outbox SET status='cancelled',claim_token=NULL,lease_until=NULL,version=version+1
    WHERE kind='invitation' AND status IN ('pending','leased')
      AND payload->>'invitationId' IN (SELECT id::text FROM consumed)
  ) SELECT barber_id FROM consumed`, [hash, tx.now, actor.telegramId]);
  if (!result.length) deny('invite_invalid');
  return result[0].barber_id;
}

export async function renderInvitation(tx: Tx, invitationId: unknown, chatId: string, options: IdentityOptions): Promise<string | null> {
  if (typeof invitationId !== 'string' || !options.botUsername || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(options.botUsername)) return null;
  const invitation = (await tx.query<{ id: Id; token_hash: string }>(`SELECT i.id,i.token_hash FROM invitations i JOIN barbers b ON b.id=i.barber_id
    JOIN telegram_users u ON u.id=i.issued_by JOIN roles r ON r.user_id=u.id AND r.role='admin'
    WHERE i.id::text=$1 AND u.telegram_id=$2 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>$3 AND b.archived_at IS NULL AND b.user_id IS NULL`, [invitationId, chatId, tx.now]))[0];
  if (!invitation) return null;
  try {
    const token = await invitationToken(invitation.id, options.invitationSecret);
    if (await hashToken(token) !== invitation.token_hash) return null;
    return `Приглашение барбера (действует 24 часа): https://t.me/${options.botUsername}?start=i_${token}`;
  } catch (error) { if (error instanceof DomainError) return null; throw error; }
}
