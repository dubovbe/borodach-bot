import pg from 'pg';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { testDatabaseUrl } from './safety';
import { migrate } from '../../scripts/migrate';
import { seed } from '../../scripts/seed';
import { nodeDatabase } from '../../scripts/node-db';
import { Repository } from '../../src/db/repository';
import { Outbox } from '../../src/notifications/outbox';
import { DeliveryError, type Delivery } from '../../src/notifications/transport';
import type { Command } from '../../src/domain/types';
import type { Database } from '../../src/db/client';
import { requirePermission, invitationToken } from '../../src/identity/service';

const schema = `stage5_${crypto.randomUUID().replaceAll('-', '')}`;
const scoped = new URL(testDatabaseUrl()); scoped.searchParams.set('options', `-c search_path=${schema}`);
const now = '2026-11-06T04:00:00.000Z';
const options = { invitationSecret: 'test-only-invitation-secret-000000000000000000', botUsername: 'identity_test_bot' };
const barber = '00000000-0000-4000-8000-000000000002';
const phone = '+79123456789';
let sql: pg.Client, created = false, update = 1000;
const db = (clock = now): Database => { const base = nodeDatabase(scoped.toString()); return { read: base.read, transaction: run => base.transaction(tx => run({ ...tx, now: clock })) }; };
const repo = (clock = now, config = options) => new Repository(db(clock), '900', config);
const execute = (id: string, command: Command, clock = now) => repo(clock).execute({ telegramId: id }, command, String(update++));
const contact = (id = '100', value = phone): Command => ({ kind: 'updateContact', contact: { userId: id, phone: value } });
const start = (id: string) => execute(id, { kind: 'start', payload: null });
async function uid(id: string) { return (await sql.query('SELECT id FROM telegram_users WHERE telegram_id=$1', [id])).rows[0].id as string; }
async function invite() {
  const result = await execute('900', { kind: 'issueBarberInvite', barberId: barber });
  expect(result.status).toBe('invite_issued');
  const deliveries: Delivery[] = [];
  await sql.query("UPDATE outbox SET status='cancelled' WHERE kind<>'invitation'");
  await new Outbox(db(), { send: async job => { deliveries.push(job); return { messageId: '1' }; } }, options).deliver(now, 5);
  const text = (deliveries[0]?.payload as { text: string })?.text;
  expect(text).toContain('https://t.me/identity_test_bot?start=i_');
  return { id: result.entityId!, token: text.split('start=i_')[1] };
}
beforeAll(async () => { sql = new pg.Client({ connectionString: scoped.toString(), connectionTimeoutMillis: 5000 }); await sql.connect(); await sql.query(`CREATE SCHEMA "${schema}"`); created = true; await migrate(scoped.toString()); });
afterAll(async () => { if (created) await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql?.end(); });
beforeEach(async () => { await sql.query('TRUNCATE outbox,jobs,telegram_users,clients,visits,barbers CASCADE'); await seed(scoped.toString()); await start('900'); await start('100'); await start('101'); });
it('own contact only, E164, no fake name, replay and same-phone idempotency', async () => {
  expect((await execute('100', contact('101'))).status).toBe('invalid_contact');
  expect((await execute('100', { kind: 'updateContact', contact: { phone } })).status).toBe('invalid_contact');
  const key = String(update++);
  const first = await repo().execute({ telegramId: '100' }, contact(), key);
  expect(first.status).toBe('contact_updated');
  expect(await repo().execute({ telegramId: '100' }, contact(), key)).toEqual(first);
  await execute('100', contact());
  expect((await sql.query('SELECT name,phone FROM clients WHERE user_id=$1', [await uid('100')])).rows).toEqual([{ name: '', phone }]);
  expect((await sql.query('SELECT * FROM phone_claims')).rows).toHaveLength(1);
});
it('independent simultaneous phone claims have one owner and collision rolls back previous claim', async () => {
  const results = await Promise.all([execute('100', contact()), execute('101', contact('101'))]);
  expect(results.map(r => r.status).sort()).toEqual(['contact_updated', 'phone_in_use']);
  expect((await sql.query('SELECT * FROM phone_claims WHERE released_at IS NULL')).rows).toHaveLength(1);
  const winner = results[0].status === 'contact_updated' ? '100' : '101';
  const loser = winner === '100' ? '101' : '100';
  await execute(loser, contact(loser, '+79123456780'));
  expect((await execute(loser, contact(loser))).status).toBe('phone_in_use');
  expect((await sql.query('SELECT phone FROM phone_claims WHERE user_id=$1 AND released_at IS NULL', [await uid(loser)])).rows[0].phone).toBe('+79123456780');
});
it('only first contact moves future confirmed manual visits; no past/manual identity takeover', async () => {
  const manual = (await sql.query('INSERT INTO clients(name,phone) VALUES($1,$2) RETURNING id', ['Manual', phone])).rows[0].id;
  const oldPhone = '+79123456780';
  const other = (await sql.query('INSERT INTO clients(name,phone) VALUES($1,$2) RETURNING id', ['Other', oldPhone])).rows[0].id;
  const visits: Record<string, string> = {};
  for (const [label, cid, status, time] of [['future', manual, 'confirmed', '2026-11-07T10:00:00Z'], ['past', manual, 'confirmed', '2026-11-05T10:00:00Z'], ['cancelled', manual, 'cancelled', '2026-11-07T12:00:00Z'], ['newphone', other, 'confirmed', '2026-11-07T14:00:00Z']] as const) {
    visits[label] = (await sql.query("INSERT INTO visits(client_id,barber_id,status,start_at,end_at,created_at) VALUES($1,$2,$3,$4,$4::timestamptz+interval '1 hour',$5) RETURNING id", [cid, barber, status, time, now])).rows[0].id;
  }
  const service = '00000000-0000-4000-8000-000000000003';
  const item = (await sql.query('INSERT INTO visit_items(visit_id,service_id,name,price_kopecks,duration_minutes) VALUES($1,$2,$3,120000,60) RETURNING id', [visits.future, service, 'Snapshot'])).rows[0].id;
  await sql.query("INSERT INTO jobs(logical_key,kind,visit_id,entity_version,due_at) VALUES('manual-reminder','reminder',$1,1,'2026-11-07T09:00:00Z')", [visits.future]);
  await sql.query("INSERT INTO outbox(logical_key,kind,chat_id,payload,due_at,entity_id,entity_version,entity_type) VALUES('old-owner','booking',900,$1::jsonb,$2,$3,1,'visit')", [JSON.stringify({ event: 'visit_confirmed', visitId: visits.future }), now, visits.future]);
  await execute('100', contact());
  const owner = (await sql.query('SELECT id FROM clients WHERE user_id=$1', [await uid('100')])).rows[0].id;
  const rows = (await sql.query('SELECT id,client_id,version FROM visits')).rows;
  expect(rows.find(r => r.id === visits.future)).toMatchObject({ client_id: owner, version: 2 });
  expect(rows.find(r => r.id === visits.past)?.client_id).toBe(manual);
  expect(rows.find(r => r.id === visits.cancelled)?.client_id).toBe(manual);
  expect((await sql.query('SELECT user_id FROM clients WHERE id=$1', [manual])).rows[0].user_id).toBeNull();
  expect((await sql.query('SELECT id,name FROM visit_items WHERE visit_id=$1', [visits.future])).rows).toEqual([{ id: item, name: 'Snapshot' }]);
  expect((await sql.query("SELECT entity_version,due_at FROM jobs WHERE logical_key='manual-reminder'")).rows[0].entity_version).toBe(2);
  expect((await sql.query("SELECT status FROM outbox WHERE logical_key='old-owner'")).rows[0].status).toBe('cancelled');
  await execute('100', contact('100', oldPhone));
  expect((await sql.query('SELECT client_id FROM visits WHERE id=$1', [visits.newphone])).rows[0].client_id).toBe(other);
  expect((await sql.query('SELECT client_id FROM visits WHERE id=$1', [visits.future])).rows[0].client_id).toBe(owner);
});
it('booking refuses unverified or incomplete profile; forged staff mutation denied in execute', async () => {
  const service = '00000000-0000-4000-8000-000000000003';
  for (let day = 1; day <= 7; day++) await sql.query('INSERT INTO weekly_hours(barber_id,weekday,start_minute,end_minute) VALUES($1,$2,0,1440) ON CONFLICT DO NOTHING', [barber, day]);
  const request: Command = { kind: 'requestBooking', barberId: barber, serviceIds: [service], start: '2026-11-07T10:00:00Z' };
  expect((await execute('100', request)).status).toBe('profile_required');
  await sql.query('UPDATE clients SET name=$1,phone=$2 WHERE user_id=$3', ['Named client', phone, await uid('100')]);
  expect((await execute('100', request)).status).toBe('profile_required');
  await execute('100', contact());
  expect((await execute('100', request)).status).toBe('pending');
  await sql.query("UPDATE clients SET name='  ' WHERE user_id=$1", [await uid('101')]);
  await execute('101', contact('101', '+79123456780'));
  expect((await execute('101', request)).status).toBe('profile_required');
  await sql.query("DELETE FROM roles WHERE user_id=$1 AND role='client'", [await uid('101')]);
  expect((await execute('101', request)).status).toBe('forbidden');
  const visit = (await sql.query('SELECT id,version FROM visits LIMIT 1')).rows[0];
  expect((await execute('101', { kind: 'confirmBooking', visitId: visit.id, expectedVersion: visit.version })).status).toBe('forbidden');
  expect((await execute('101', { kind: 'cancelBooking', visitId: visit.id, expectedVersion: visit.version })).status).toBe('forbidden');
  expect((await execute('100', { kind: 'issueBarberInvite', barberId: barber })).status).toBe('forbidden');
});
it('invitation is hash-only in all durable JSON, exact replay and one independent redeemer', async () => {
  const { id, token } = await invite();
  const serialized = JSON.stringify((await sql.query('SELECT row_to_json(i) AS value FROM invitations i UNION ALL SELECT row_to_json(o) FROM outbox o UNION ALL SELECT row_to_json(p) FROM processed_updates p UNION ALL SELECT row_to_json(a) FROM audit_events a')).rows);
  expect(serialized).not.toContain(token); expect(serialized).not.toContain('https://t.me');
  const commands: Command[] = [{ kind: 'redeemInvite', token }, { kind: 'redeemInvite', token }];
  const results = await Promise.all(commands.map((c, i) => execute(String(100 + i), c)));
  expect(results.map(r => r.status).sort()).toEqual(['invite_invalid', 'invite_redeemed']);
  expect((await sql.query('SELECT used_by FROM invitations WHERE id=$1', [id])).rows[0].used_by).not.toBeNull();
  expect((await sql.query("SELECT role FROM roles WHERE user_id=(SELECT user_id FROM barbers WHERE id=$1) ORDER BY role", [barber])).rows.map(r => r.role)).toEqual(['barber', 'client']);
  expect((await execute('100', { kind: 'redeemInvite', token })).status).toBe('invite_invalid');
});
it('expiry boundary and revocation stop redemption and cancel pending link delivery', async () => {
  const issued = await execute('900', { kind: 'issueBarberInvite', barberId: barber });
  expect(issued.status).toBe('invite_issued');
  const row = (await sql.query('SELECT expires_at FROM invitations WHERE id=$1', [issued.entityId])).rows[0];
  expect(row.expires_at.toISOString()).toBe('2026-11-07T04:00:00.000Z');
  const delivered: Delivery[] = [];
  await sql.query("UPDATE outbox SET status='cancelled' WHERE kind<>'invitation'");
  expect((await execute('900', { kind: 'revokeInvite', invitationId: issued.entityId! })).status).toBe('invite_revoked');
  await new Outbox(db(), { send: async job => { delivered.push(job); return { messageId: '1' }; } }, options).deliver(now, 5);
  expect(delivered.filter(d => (d.payload as { text: string }).text.includes('https://t.me'))).toHaveLength(0);
  expect((await sql.query("SELECT status FROM outbox WHERE kind='invitation' AND payload->>'invitationId'=$1", [issued.entityId])).rows[0].status).toBe('cancelled');
});
it('outbox retry regenerates token and does not store link even after provider failure', async () => {
  await execute('900', { kind: 'issueBarberInvite', barberId: barber });
  await sql.query("UPDATE outbox SET status='cancelled' WHERE kind<>'invitation'");
  const sent: Delivery[] = []; let fail = true;
  const transport = { send: async (job: Delivery) => { sent.push(job); if (fail) { fail = false; throw new DeliveryError('transient'); } return { messageId: '2' }; } };
  await new Outbox(db(), transport, options).deliver(now, 1);
  await new Outbox(db('2026-11-06T04:01:00Z'), transport, options).deliver('2026-11-06T04:01:00Z', 1);
  expect(sent).toHaveLength(2); expect(sent[0].payload).toEqual(sent[1].payload);
  const raw = JSON.stringify((await sql.query('SELECT payload FROM outbox')).rows);
  expect(raw).not.toContain('https://t.me');
});

it('bootstrap and permissions are cumulative, scoped, and default deny even for admin', async () => {
  await start('900'); await start('900');
  expect((await sql.query("SELECT * FROM roles WHERE user_id=$1 AND role='admin'", [await uid('900')])).rows).toHaveLength(1);
  const own = (await sql.query('SELECT id FROM clients WHERE user_id=$1', [await uid('100')])).rows[0].id;
  const foreign = (await sql.query('SELECT id FROM clients WHERE user_id=$1', [await uid('101')])).rows[0].id;
  const check = (id: string, action: string, resource: { barberId?: string; clientId?: string }) => db().transaction(tx => requirePermission({ telegramId: id }, action, resource, tx));
  await expect(check('100', 'readClientProfile', { clientId: own })).resolves.toBeUndefined();
  await expect(check('100', 'readClientProfile', { clientId: foreign })).rejects.toMatchObject({ code: 'forbidden' });
  for (const action of ['unknown', 'toString', 'constructor']) await expect(check('900', action, { barberId: barber })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(check('900', 'readStatistics', {})).rejects.toMatchObject({ code: 'forbidden' });
  await expect(check('900', 'issueBarberInvite', { clientId: own })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(check('100', 'readStatistics', { barberId: barber })).rejects.toMatchObject({ code: 'forbidden' });
  const { token } = await invite();
  const key = String(update++);
  const redeemed = await repo().execute({ telegramId: '100' }, { kind: 'redeemInvite', token }, key);
  expect(await repo().execute({ telegramId: '100' }, { kind: 'redeemInvite', token }, key)).toEqual(redeemed);
  await expect(check('100', 'readStatistics', { barberId: barber })).resolves.toBeUndefined();
  await expect(check('100', 'readClientProfile', { clientId: own })).resolves.toBeUndefined();
  await expect(check('100', 'readStatistics', { barberId: barber, clientId: foreign })).rejects.toMatchObject({ code: 'forbidden' });
  await sql.query('UPDATE barbers SET archived_at=$1 WHERE id=$2', [now, barber]);
  await expect(check('100', 'readStatistics', { barberId: barber })).rejects.toMatchObject({ code: 'forbidden' });
});
it('strict expiry, revoked, archived, already linked and second-profile invitations refuse safely', async () => {
  const issued = await execute('900', { kind: 'issueBarberInvite', barberId: barber });
  const token = await invitationToken(issued.entityId!, options.invitationSecret);
  expect((await execute('100', { kind: 'redeemInvite', token }, '2026-11-07T04:00:00.000Z')).status).toBe('invite_invalid');
  expect((await execute('100', { kind: 'redeemInvite', token }, '2026-11-07T04:00:01.000Z')).status).toBe('invite_invalid');
  await execute('900', { kind: 'revokeInvite', invitationId: issued.entityId! });
  expect((await execute('100', { kind: 'redeemInvite', token })).status).toBe('invite_invalid');
  const again = await execute('900', { kind: 'issueBarberInvite', barberId: barber });
  const next = await invitationToken(again.entityId!, options.invitationSecret);
  const second = crypto.randomUUID();
  await sql.query('INSERT INTO barbers(id,name,user_id) VALUES($1,$2,$3)', [second, 'Existing barber', await uid('100')]);
  expect((await execute('100', { kind: 'redeemInvite', token: next })).status).toBe('invite_invalid');
  await sql.query('UPDATE barbers SET archived_at=$1 WHERE id=$2', [now, barber]);
  expect((await execute('101', { kind: 'redeemInvite', token: next })).status).toBe('invite_invalid');
  await sql.query('UPDATE barbers SET archived_at=NULL,user_id=$1 WHERE id=$2', [await uid('101'), barber]);
  expect((await execute('100', { kind: 'redeemInvite', token: next })).status).toBe('invite_invalid');
  expect((await execute('900', { kind: 'issueBarberInvite', barberId: barber })).status).toBe('invite_invalid');
});
it('missing or weak invitation configuration refuses before creating invitation', async () => {
  for (const invitationSecret of ['', 'x'.repeat(40)]) {
    const result = await repo(now, { ...options, invitationSecret }).execute({ telegramId: '900' }, { kind: 'issueBarberInvite', barberId: barber }, String(update++));
    expect(result.status).toBe('invitation_unconfigured');
  }
  expect((await sql.query('SELECT * FROM invitations')).rows).toHaveLength(0);
});
it('private contact keyboards survive real outbox preparation and are removed after verification', async () => {
  const deliveries: Delivery[] = [];
  const transport = { send: async (job: Delivery) => { deliveries.push(job); return { messageId: 'keyboard' }; } };
  await new Outbox(db(), transport, options).deliver(now, 5);
  const prompt = deliveries.find(d => d.chatId === '100')?.payload as { reply_markup: unknown };
  expect(prompt.reply_markup).toMatchObject({ keyboard: [[{ request_contact: true }]] });
  deliveries.length = 0;
  await execute('100', contact());
  await new Outbox(db(), transport, options).deliver(now, 5);
  expect((deliveries.find(d => d.chatId === '100')?.payload as { reply_markup: unknown }).reply_markup).toEqual({ remove_keyboard: true });
});

it.each(['success', 'transient'] as const)('revocation fences an in-flight invitation with late %s result', async (outcome) => {
  const issued = await execute('900', { kind: 'issueBarberInvite', barberId: barber });
  expect(issued.status).toBe('invite_issued');
  await sql.query("UPDATE outbox SET status='cancelled' WHERE kind<>'invitation'");
  let entered!: () => void;
  const reachedTransport = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let sends = 0;
  const transport = {
send: async () => {
      sends++;
      entered();
      await released;
      if (outcome === 'transient') throw new DeliveryError('transient');
      return { messageId: 'late-success' };
    }
};
  const running = new Outbox(db(), transport, options).deliver(now, 1);
  await reachedTransport;
  let cancelled: Record<string, unknown>;
  try {
    const revoked = await execute('900', { kind: 'revokeInvite', invitationId: issued.entityId! });
    expect(revoked.status).toBe('invite_revoked');
    cancelled = (await sql.query("SELECT status,claim_token,lease_until,version FROM outbox WHERE kind='invitation' AND payload->>'invitationId'=$1", [issued.entityId])).rows[0];
  } finally {
    release();
    await running;
  }
  const after = (await sql.query("SELECT status,claim_token,lease_until,version,message_id FROM outbox WHERE kind='invitation' AND payload->>'invitationId'=$1", [issued.entityId])).rows[0];
  expect(cancelled!).toMatchObject({ status: 'cancelled', claim_token: null, lease_until: null });
  expect(after).toMatchObject({ ...cancelled!, message_id: null });
  await sql.query("UPDATE outbox SET status='cancelled' WHERE kind<>'invitation'");
  await new Outbox(db('2026-11-06T04:01:00Z'), transport, options).deliver('2026-11-06T04:01:00Z', 5);
  expect(sends).toBe(1);
});

it('replacement and redemption atomically cancel queued invitation deliveries', async () => {
  const first = await execute('900', { kind: 'issueBarberInvite', barberId: barber });
  expect(first.status).toBe('invite_issued');
  const second = await execute('900', { kind: 'issueBarberInvite', barberId: barber });
  expect(second.status).toBe('invite_issued');
  const old = (await sql.query("SELECT status,claim_token,lease_until FROM outbox WHERE kind='invitation' AND payload->>'invitationId'=$1", [first.entityId])).rows[0];
  expect(old).toEqual({ status: 'cancelled', claim_token: null, lease_until: null });
  const token = await invitationToken(second.entityId!, options.invitationSecret);
  expect((await execute('100', { kind: 'redeemInvite', token })).status).toBe('invite_redeemed');
  const consumed = (await sql.query("SELECT status,claim_token,lease_until FROM outbox WHERE kind='invitation' AND payload->>'invitationId'=$1", [second.entityId])).rows[0];
  expect(consumed).toEqual({ status: 'cancelled', claim_token: null, lease_until: null });
});
