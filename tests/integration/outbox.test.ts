import pg from 'pg';
import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { testDatabaseUrl } from './safety';
import { migrate } from '../../scripts/migrate';
import { seed } from '../../scripts/seed';
import { nodeDatabase } from '../../scripts/node-db';
import { Repository } from '../../src/db/repository';
import { Outbox } from '../../src/notifications/outbox';
import { DeliveryError } from '../../src/notifications/transport';
const url = testDatabaseUrl(), schema = `stage4_${crypto.randomUUID().replaceAll('-', '')}`;
const scoped = new URL(url);
scoped.searchParams.set('options', `-c search_path=${schema}`);
let admin: pg.Client;
let created = false;
const db = () => nodeDatabase(scoped.toString());
const repo = () => new Repository(db(), '100');
beforeAll(async () => {
    admin = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await admin.query(`SET search_path TO "${schema}"`);
    await migrate(scoped.toString());
    await seed(scoped.toString());
});
afterAll(async () => {
    if (created)
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
});
beforeEach(async () => {
    await admin.query('TRUNCATE outbox,jobs,audit_events,processed_updates,holds,visit_items,transfers,visits,clients,roles,telegram_users CASCADE');
    await seed(scoped.toString());
    await admin.query("UPDATE barbers SET name='Вымышленный мастер'");
    await admin.query("UPDATE shop SET address='Вымышленная улица, 1'");
});
async function message(key = 'one') {
    return (await admin.query(`INSERT INTO outbox(logical_key,kind,chat_id,payload,due_at) VALUES($1,'start',100,'{"text":"hello"}',clock_timestamp()) RETURNING id`, [key])).rows[0].id;
}
async function visit() {
    await repo().execute({ telegramId: '100' }, { kind: 'start', payload: null }, '1');
    await admin.query("INSERT INTO roles(user_id,role) SELECT id,'barber' FROM telegram_users WHERE telegram_id=100 ON CONFLICT DO NOTHING");
    await admin.query('UPDATE barbers SET user_id=(SELECT id FROM telegram_users WHERE telegram_id=100)');
    const client = (await admin.query("INSERT INTO clients(user_id,name) SELECT id,'Test' FROM telegram_users WHERE telegram_id=100 ON CONFLICT(user_id) DO UPDATE SET name=EXCLUDED.name RETURNING id")).rows[0].id;
    const barber = (await admin.query('SELECT id FROM barbers LIMIT 1')).rows[0].id;
    const id = (await admin.query(`INSERT INTO visits(client_id,barber_id,status,start_at,end_at,deadline,created_at) VALUES($1,$2,'pending',clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day 1 hour',clock_timestamp()-interval '1 second',clock_timestamp()) RETURNING id`, [client, barber])).rows[0].id;
    await admin.query('DELETE FROM outbox');
    return id;
}
it('outbox_lease_survives_crash', async () => {
    await message();
    let release!: () => void;
    const accepted = new Promise<void>(r => {
        release = r;
    });
    let entered!: () => void;
    const started = new Promise<void>(r => {
        entered = r;
    });
    const first = new Outbox(db(), { send: async () => {
            entered();
            await accepted;
            return { messageId: '1' };
        } }).deliver(new Date().toISOString(), 1);
    await started;
    let sends = 0;
    await new Outbox(db(), { send: async () => {
            sends++;
            return { messageId: '2' };
        } }).deliver(new Date().toISOString(), 1);
    expect(sends).toBe(0);
    release();
    await first;
    expect((await admin.query('SELECT status FROM outbox')).rows[0].status).toBe('sent');
});
it('stale_claim_owner_cannot_overwrite_new_success', async () => {
    const id = await message();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(r => {
        entered = r;
    });
    const first = new Outbox(db(), { send: async () => {
            entered();
            await new Promise<void>(r => {
                release = r;
            });
            throw new DeliveryError('transient');
        } }).deliver(new Date().toISOString(), 1);
    await started;
    await admin.query("UPDATE outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    await new Outbox(db(), { send: async () => ({ messageId: 'new' }) }).deliver(new Date().toISOString(), 1);
    release();
    await first;
    expect((await admin.query('SELECT status,message_id FROM outbox WHERE id=$1', [id])).rows[0]).toMatchObject({ status: 'sent', message_id: 'new' });
});
it('telegram_429_uses_retry_after', async () => {
    await message();
    await new Outbox(db(), { send: async () => {
            throw new DeliveryError('rate_limited', 900);
        } }).deliver(new Date().toISOString(), 1);
    const row = (await admin.query('SELECT status,extract(epoch from due_at-clock_timestamp()) AS delay FROM outbox')).rows[0];
    expect(row.status).toBe('pending');
    expect(Number(row.delay)).toBeGreaterThan(890);
});
it('telegram_403_marks_unreachable_without_undoing_booking', async () => {
    const id = await visit();
    await admin.query("UPDATE visits SET status='confirmed' WHERE id=$1", [id]);
    await message();
    await new Outbox(db(), { send: async () => {
            throw new DeliveryError('unreachable');
        } }).deliver(new Date().toISOString(), 1);
    expect((await admin.query('SELECT unreachable_at FROM telegram_users')).rows[0].unreachable_at).not.toBeNull();
    expect((await admin.query('SELECT status FROM visits WHERE id=$1', [id])).rows[0].status).toBe('confirmed');
    expect((await admin.query('SELECT status FROM outbox WHERE logical_key=$1', ['one'])).rows[0].status).toBe('failed');
    await repo().execute({ telegramId: '100' }, { kind: 'start', payload: null }, '2');
    expect((await admin.query('SELECT unreachable_at FROM telegram_users')).rows[0].unreachable_at).toBeNull();
});
it('duplicate_alarm_does_not_duplicate_job_effect', async () => {
    const id = await visit();
    await admin.query("INSERT INTO jobs(logical_key,kind,visit_id,entity_version,due_at) VALUES('expire','expire_visit',$1,1,clock_timestamp())", [id]);
    await Promise.all([repo().drainDue(new Date().toISOString(), 5), repo().drainDue(new Date().toISOString(), 5)]);
    expect((await admin.query('SELECT status,version FROM visits WHERE id=$1', [id])).rows[0]).toMatchObject({ status: 'expired', version: 2 });
    expect((await admin.query("SELECT count(*)::int n FROM audit_events WHERE kind='visit_expired' AND source='system' AND actor_id IS NULL AND update_id IS NULL")).rows[0].n).toBe(1);
    expect((await admin.query("SELECT count(*)::int n FROM outbox WHERE kind='booking'")).rows[0].n).toBe(1);
});
it('stale_entity_is_cancelled_before_external_send', async () => {
    const id = await visit();
    await admin.query(`INSERT INTO outbox(logical_key,kind,chat_id,payload,due_at,entity_id,entity_version) VALUES('stale','booking',100,$2,clock_timestamp(),$1,1)`, [id, JSON.stringify({ event: 'visit_pending', visitId: id })]);
    await admin.query("UPDATE visits SET status='cancelled',version=2 WHERE id=$1", [id]);
    let sent = 0;
    await new Outbox(db(), { send: async () => {
            sent++;
            return { messageId: 'x' };
        } }).deliver(new Date().toISOString(), 5);
    expect(sent).toBe(0);
    expect((await admin.query('SELECT status FROM outbox')).rows[0].status).toBe('cancelled');
});
it('bounded_jobs_include_stale_and_unknown_attempts', async () => {
    for (let i = 0; i < 7; i++)
        await admin.query("INSERT INTO jobs(logical_key,kind,entity_version,due_at) VALUES($1,'unknown',1,clock_timestamp())", [String(i)]);
    const result = await repo().drainDue(new Date().toISOString(), 5);
    expect(result.processedCount).toBe(5);
    expect(result.remaining).toBe(true);
    expect((await admin.query("SELECT count(*)::int n FROM jobs WHERE status='pending'")).rows[0].n).toBe(2);
});
it('next_due_excludes_terminal_and_includes_active_lease_ends', async () => {
    await message();
    await admin.query("UPDATE outbox SET status='failed'");
    expect(await repo().nextDue()).toBeNull();
    await message('leased');
    await admin.query("UPDATE outbox SET status='leased',claim_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '1 minute' WHERE logical_key='leased'");
    expect(Date.parse((await repo().nextDue())!) - Date.now()).toBeGreaterThan(50000);
});
it('malformed_payload_is_terminal', async () => {
    await message();
    await admin.query("UPDATE outbox SET payload='{}'");
    let sent = 0;
    await new Outbox(db(), { send: async () => {
            sent++;
            return { messageId: 'x' };
        } }).deliver(new Date().toISOString(), 1);
    expect(sent).toBe(0);
    expect((await admin.query('SELECT status,last_error FROM outbox')).rows[0]).toMatchObject({ status: 'failed', last_error: 'invalid_payload' });
});
it('mark_failure_after_accepted_send_keeps_lease_until_recovery', async () => {
    const id = await message();
    let accepted = 0;
    let fail = true;
    const base = db();
    const failing = { read: base.read.bind(base), transaction: ((run: Parameters<typeof base.transaction>[0]) => base.transaction(tx => run({ ...tx, query: async (sql: string, values: unknown[]) => {
                if (fail && sql.startsWith('UPDATE outbox SET status=$3') && values[2] === 'sent') {
                    fail = false;
                    throw Error('ack unavailable');
                }
                return tx.query(sql, values);
            } }))) as typeof base.transaction };
    const send = { send: async () => {
            accepted++;
            return { messageId: String(accepted) };
        } };
    await expect(new Outbox(failing, send).deliver(new Date().toISOString(), 1)).rejects.toThrow('ack unavailable');
    expect((await admin.query('SELECT status FROM outbox WHERE id=$1', [id])).rows[0].status).toBe('leased');
    await new Outbox(db(), send).deliver(new Date().toISOString(), 1);
    expect(accepted).toBe(1);
    await admin.query("UPDATE outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    await new Outbox(db(), send).deliver(new Date().toISOString(), 1);
    expect(accepted).toBe(2);
    expect((await admin.query('SELECT status FROM outbox WHERE id=$1', [id])).rows[0].status).toBe('sent');
});
it('unreachable_notice_is_deduplicated_and_cannot_recurse', async () => {
    await repo().execute({ telegramId: '100' }, { kind: 'start', payload: null }, '100');
    await repo().execute({ telegramId: '200' }, { kind: 'start', payload: null }, '200');
    await admin.query("INSERT INTO roles(user_id,role) SELECT id,'admin' FROM telegram_users WHERE telegram_id=200");
    await admin.query('DELETE FROM outbox');
    const failedMessageId = await message();
    const fail = { send: async () => {
            throw new DeliveryError('unreachable');
        } };
    await new Outbox(db(), fail).deliver(new Date().toISOString(), 1);
    expect((await admin.query("SELECT count(*)::int n FROM outbox WHERE kind='delivery_failure'")).rows[0].n).toBe(1);
    expect((await admin.query("SELECT payload FROM outbox WHERE kind='delivery_failure'")).rows[0].payload.text).toContain(failedMessageId);
    await new Outbox(db(), fail).deliver(new Date().toISOString(), 5);
    expect((await admin.query("SELECT count(*)::int n FROM outbox WHERE kind='delivery_failure'")).rows[0].n).toBe(1);
    expect((await admin.query("SELECT status FROM outbox WHERE kind='delivery_failure'")).rows[0].status).toBe('failed');
});
it('malformed_confirmation_snapshot_is_terminal', async () => {
    const id = await visit();
    await admin.query("UPDATE visits SET status='confirmed' WHERE id=$1", [id]);
    await admin.query(`INSERT INTO outbox(logical_key,kind,chat_id,payload,due_at,entity_id,entity_version) VALUES('bad-snapshot','booking',100,$2,clock_timestamp(),$1,1)`, [id, JSON.stringify({ event: 'visit_confirmed', visitId: id, snapshot: { barber: 'Test', address: 'Test', start: new Date().toISOString(), items: [null] } })]);
    await new Outbox(db(), { send: async () => ({ messageId: 'x' }) }).deliver(new Date().toISOString(), 1);
    expect((await admin.query('SELECT status,last_error FROM outbox')).rows[0]).toMatchObject({ status: 'failed', last_error: 'invalid_payload' });
});
it('confirmation_renders_creation_snapshot_after_catalog_changes', async () => {
    const id = await visit();
    await admin.query("UPDATE visits SET deadline=clock_timestamp()+interval '1 hour' WHERE id=$1", [id]);
    await admin.query("INSERT INTO visit_items(visit_id,service_id,name,price_kopecks,duration_minutes) SELECT $1,id,'Сохранённая услуга',150000,45 FROM services LIMIT 1", [id]);
    expect((await repo().execute({ telegramId: '100' }, { kind: 'confirmBooking', visitId: id, expectedVersion: 1 }, '88')).status).toBe('confirmed');
    await admin.query("UPDATE barbers SET name='Changed'");
    await admin.query("UPDATE shop SET address='Changed'");
    const texts: string[] = [];
    await new Outbox(db(), { send: async (job) => {
            texts.push((job.payload as {
                text: string;
            }).text);
            return { messageId: '1' };
        } }).deliver(new Date().toISOString(), 5);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('Вымышленный мастер');
    expect(texts[0]).toContain('Вымышленная улица, 1');
    expect(texts[0]).toContain('Сохранённая услуга');
    expect(texts[0]).toContain('1500');
    expect(texts[0]).toContain('45 мин.');
    expect(texts[0]).toContain('МСК');
});
it('cancellation_invalidates_existing_lease_and_delivers_terminal_event', async () => {
    const id = await visit();
    await admin.query("UPDATE visits SET status='confirmed',deadline=NULL WHERE id=$1", [id]);
    await admin.query(`INSERT INTO outbox(logical_key,kind,chat_id,payload,due_at,entity_id,entity_version,status,claim_token,lease_until) VALUES('old','booking',100,$2,clock_timestamp(),$1,1,'leased',gen_random_uuid(),clock_timestamp()+interval '1 minute')`, [id, JSON.stringify({ event: 'visit_confirmed', visitId: id })]);
    expect((await repo().execute({ telegramId: '100' }, { kind: 'cancelBooking', visitId: id, expectedVersion: 1, reason: 'Причина' }, '89')).status).toBe('cancelled');
    expect((await admin.query("SELECT status,claim_token FROM outbox WHERE logical_key='old'")).rows[0]).toMatchObject({ status: 'cancelled', claim_token: null });
    const texts: string[] = [];
    await new Outbox(db(), { send: async (job) => {
            texts.push((job.payload as {
                text: string;
            }).text);
            return { messageId: '1' };
        } }).deliver(new Date().toISOString(), 5);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('Причина');
    expect(texts[0]).toContain('Приносим извинения');
});
it('orphaned_null_lease_is_reclaimed_then_queue_becomes_idle', async () => {
    const id = await message();
    await admin.query("UPDATE outbox SET status='leased',claim_token=gen_random_uuid(),lease_until=NULL WHERE id=$1", [id]);
    let sent = 0;
    const result = await new Outbox(db(), { send: async () => {
            sent++;
            return { messageId: 'recovered' };
        } }).deliver(new Date().toISOString(), 1);
    expect(result.processedCount).toBe(1);
    expect(sent).toBe(1);
    expect(await repo().nextDue()).toBeNull();
    expect((await admin.query('SELECT status FROM outbox WHERE id=$1', [id])).rows[0].status).toBe('sent');
});
it('late_403_does_not_poison_user_restored_by_new_start', async () => {
    await repo().execute({ telegramId: '100' }, { kind: 'start', payload: null }, '401');
    await admin.query('DELETE FROM outbox');
    const oldId = await message();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
        entered = resolve;
    });
    const held = new Promise<void>(resolve => {
        release = resolve;
    });
    const oldDelivery = new Outbox(db(), { send: async () => {
            entered();
            await held;
            throw new DeliveryError('unreachable');
        } }).deliver(new Date().toISOString(), 1);
    await started;
    try {
        await repo().execute({ telegramId: '100' }, { kind: 'start', payload: null }, '402');
    }
    finally {
        release();
    }
    await oldDelivery;
    expect((await admin.query('SELECT status FROM outbox WHERE id=$1', [oldId])).rows[0].status).toBe('failed');
    expect((await admin.query('SELECT unreachable_at FROM telegram_users WHERE telegram_id=100')).rows[0].unreachable_at).toBeNull();
    let sent = 0;
    await new Outbox(db(), { send: async () => {
            sent++;
            return { messageId: 'new-start' };
        } }).deliver(new Date().toISOString(), 1);
    expect(sent).toBe(1);
    expect((await admin.query('SELECT status FROM outbox WHERE update_id=402')).rows[0].status).toBe('sent');
});
