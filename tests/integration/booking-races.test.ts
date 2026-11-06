import pg from 'pg';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { testDatabaseUrl } from './safety';
import { migrate } from '../../scripts/migrate';
import { seed } from '../../scripts/seed';
import { Repository } from '../../src/db/repository';
import { nodeDatabase } from '../../scripts/node-db';
import type { Command } from '../../src/domain/types';
import type { Database } from '../../src/db/client';
const url = testDatabaseUrl();
const schema = `stage3_${crypto.randomUUID().replaceAll('-', '')}`;
const scoped = new URL(url);
scoped.searchParams.set('options', `-c search_path=${schema}`);
let admin: pg.Client;
let created = false;
const b = '00000000-0000-4000-8000-000000000002', s = '00000000-0000-4000-8000-000000000003';
const b2 = '00000000-0000-4000-8000-000000000004';
const now = '2026-11-06T04:00:00.000Z';
// Boundary fixture overrides ONLY Tx.now; production always reads PostgreSQL after shop lock.
const db = (clock = now): Database => { const base = nodeDatabase(scoped.toString()); return { read: base.read, transaction: run => base.transaction(tx => run({ ...tx, now: clock })) }; };
const repo = (clock = now) => new Repository(db(clock));
const execute = (id: string, command: Command, update: string, clock = now) => repo(clock).execute({ telegramId: id }, command, update);
const request = (barberId = b, start = '2026-11-06T07:00:00.000Z'): Extract<Command,{kind:'requestBooking'}> => ({ kind: 'requestBooking', barberId, serviceIds: [s], start });
const change = (kind: 'confirmBooking' | 'cancelBooking' | 'declineBooking', visitId: string, expectedVersion = 1, reason?: string): Command => ({ kind, visitId, expectedVersion, reason });
beforeAll(async () => { admin = new pg.Client({ connectionString: scoped.toString(), connectionTimeoutMillis: 5000 }); await admin.connect(); await admin.query(`CREATE SCHEMA "${schema}"`); created = true; await migrate(scoped.toString()); await seed(scoped.toString()); });
afterAll(async () => { if (created)
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin?.end(); });
beforeEach(async () => {
    await admin.query('TRUNCATE telegram_users,visits,weekly_hours,date_exceptions CASCADE');
    await seed(scoped.toString());
    for (const id of ['100', '101', '200', '201']) {
        const user = (await admin.query('INSERT INTO telegram_users(telegram_id,last_seen_at) VALUES($1,$2) RETURNING id', [id, now])).rows[0].id;
        await admin.query('INSERT INTO roles(user_id,role) VALUES($1,$2)', [user, id === '201' ? 'admin' : id === '200' ? 'barber' : 'client']);
        if (id === '100' || id === '101') {
            const phone = id === '100' ? '+79123456789' : '+79123456780';
            const client = (await admin.query('INSERT INTO clients(user_id,name,phone) VALUES($1,$2,$3) RETURNING id', [user, 'Test',phone])).rows[0].id;
            await admin.query('INSERT INTO phone_claims(client_id,user_id,phone,claimed_at) VALUES($1,$2,$3,$4)',[client,user,phone,now]);
        }
        if (id === '200')
            await admin.query('UPDATE barbers SET user_id=$1 WHERE id=$2', [user, b]);
    }
    await admin.query('INSERT INTO barbers(id,name,rank_id) SELECT $1,$2,rank_id FROM barbers WHERE id=$3 ON CONFLICT(id) DO UPDATE SET version=1', [b2, 'Second', b]);
    await admin.query('UPDATE barbers SET version=1');
    await admin.query('INSERT INTO assignments(barber_id,service_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [b2, s]);
    await admin.query('UPDATE rank_tariffs SET duration_minutes=90,price_kopecks=150000');
    for (const barber of [b, b2])
        for (let day = 1; day <= 7; day++)
            await admin.query('INSERT INTO weekly_hours(barber_id,weekday,start_minute,end_minute) VALUES($1,$2,0,1200)', [barber, day]);
});
it('overlapping independent connections only one succeeds and adjacency works', async () => {
    const sixtyMinuteService = crypto.randomUUID();
    await admin.query('INSERT INTO services(id,name) VALUES($1,$2)', [sixtyMinuteService, 'Sixty-minute service']);
    await admin.query('INSERT INTO rank_tariffs(rank_id,service_id,price_kopecks,duration_minutes) SELECT rank_id,$1,100000,60 FROM barbers WHERE id=$2', [sixtyMinuteService, b]);
    await admin.query('INSERT INTO assignments(barber_id,service_id) VALUES($1,$2)', [b, sixtyMinuteService]);
    // Moscow 10:00–11:30 versus 11:00–12:00, through independent transaction connections.
    const secondRequest = { ...request(b, '2026-11-06T08:00:00.000Z'), serviceIds: [sixtyMinuteService] };
    const results = await Promise.all([execute('100', request(), '1'), execute('101', secondRequest, '2')]);
    expect(results.map(r => r.status).sort()).toEqual(['pending', 'slot_unavailable']);
    const accepted = results.find(r => r.status === 'pending')!;
    const firstWon = results[0].status === 'pending';
    const acceptedInterval = (await admin.query('SELECT start_at,end_at FROM visits WHERE id=$1', [accepted.entityId])).rows[0];
    expect(acceptedInterval.start_at.toISOString()).toBe(firstWon ? '2026-11-06T07:00:00.000Z' : '2026-11-06T08:00:00.000Z');
    expect(acceptedInterval.end_at.toISOString()).toBe(firstWon ? '2026-11-06T08:30:00.000Z' : '2026-11-06T09:00:00.000Z');
    expect((await execute('200', change('confirmBooking', accepted.entityId!), '3')).status).toBe('confirmed');
    const adjacent = firstWon ? '2026-11-06T08:30:00.000Z' : '2026-11-06T09:00:00.000Z';
    expect((await execute('100', request(b, adjacent), '4')).status).toBe('pending');
});
it('one pending across barbers but two sequential confirmed future visits possible', async () => {
    const results = await Promise.all([execute('100', request(), '10'), execute('100', request(b2), '11')]);
    expect(results.map(r => r.status).sort()).toEqual(['pending', 'pending_limit']);
    const v = results.find(r => r.status === 'pending')!;
    expect((await execute('201', change('confirmBooking', v.entityId!), '12')).status).toBe('confirmed');
    const second = await execute('100', request(b, '2026-11-06T09:00:00.000Z'), '13');
    expect(second.status).toBe('pending');
    expect((await execute('201', change('confirmBooking', second.entityId!), '14')).status).toBe('confirmed');
    const confirmed = await admin.query("SELECT count(*)::integer AS n FROM visits v JOIN clients c ON c.id=v.client_id JOIN telegram_users u ON u.id=c.user_id WHERE u.telegram_id=100 AND v.status='confirmed' AND v.start_at>$1", [now]);
    expect(confirmed.rows[0].n).toBe(2);
});
it('duplicate updates create one visit and exact deadline expiry cleanup persists', async () => {
    const results = await Promise.all([execute('100', request(), '20'), execute('100', request(), '20')]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].status).toBe('pending');
    const v = results[0].entityId!;
    const deadline = (await admin.query('SELECT deadline FROM visits WHERE id=$1', [v])).rows[0].deadline.toISOString();
    expect((await execute('200', change('confirmBooking', v), '21', deadline)).status).not.toBe('confirmed');
    expect((await admin.query('SELECT status FROM visits WHERE id=$1', [v])).rows[0].status).toBe('expired');
    expect((await admin.query('SELECT * FROM holds WHERE visit_id=$1', [v])).rows).toHaveLength(0);
    expect((await execute('101', request(), '22', deadline)).status).toBe('pending');
    expect((await admin.query('SELECT * FROM visits')).rows).toHaveLength(2);
});
it('ownership stale version and immutable snapshots', async () => {
    const v = (await execute('100', request(), '30')).entityId!;
    expect((await execute('101', change('cancelBooking', v), '31')).status).toBe('forbidden');
    expect((await execute('200', change('confirmBooking', v, 2), '32')).status).toBe('stale_version');
    await admin.query('UPDATE rank_tariffs SET price_kopecks=1,duration_minutes=15');
    expect((await execute('200', change('confirmBooking', v), '33')).status).toBe('confirmed');
    expect((await admin.query('SELECT price_kopecks,duration_minutes FROM visit_items WHERE visit_id=$1', [v])).rows).toEqual([{ price_kopecks: 150000, duration_minutes: 90 }]);
    expect((await execute('200', change('cancelBooking', v, 2), '34')).status).toBe('reason_required');
    expect((await execute('100', change('cancelBooking', v, 2), '35')).status).toBe('cancelled');
});
it('admin schedule versus request serialized; barber edit refused', async () => {
    const schedule = { timezone: 'Europe/Moscow' as const, weekly: {}, exceptions: {} };
    const cmd: Command = { kind: 'changeSchedule', barberId: b, expectedVersion: 1, schedule };
    expect((await execute('200', cmd, '40')).status).toBe('forbidden');
    const [a, c] = await Promise.all([execute('201', cmd, '41'), execute('100', request(), '42')]);
    expect((a.status === 'schedule_changed' && c.status === 'slot_unavailable') || (a.status === 'schedule_conflict' && c.status === 'pending')).toBe(true);
});
it('live client transfer at another barber counts toward pending limit', async () => {
    const v = (await execute('100', request(), '50')).entityId!;
    await execute('200', change('confirmBooking', v), '51');
    await admin.query("INSERT INTO transfers(visit_id,initiator,status,new_start_at,new_end_at,deadline) VALUES($1,'client','pending',$2,$3,$4)", [v, '2026-11-06T10:00:00Z', '2026-11-06T11:30:00Z', '2026-11-06T06:00:00Z']);
    expect((await execute('100', request(b2), '52')).status).toBe('pending_limit');
});
it('real PostgreSQL rank tariff and individual override with availability guards', async () => {
    const { effectiveOffer } = await import('../../src/catalog/service');
    expect((await db().transaction(tx => effectiveOffer(b, [s], tx)))).toMatchObject({ priceKopecks: 150000, durationMinutes: 90 });
    await admin.query('INSERT INTO barber_tariffs(barber_id,service_id,price_kopecks,duration_minutes) VALUES($1,$2,0,30)', [b, s]);
    expect((await db().transaction(tx => effectiveOffer(b, [s], tx)))).toMatchObject({ priceKopecks: 0, durationMinutes: 30 });
    await admin.query('DELETE FROM assignments WHERE barber_id=$1', [b]);
    await expect(db().transaction(tx => effectiveOffer(b, [s], tx))).rejects.toMatchObject({ code: 'offer_unavailable' });
    await admin.query('INSERT INTO assignments(barber_id,service_id) VALUES($1,$2)', [b, s]);
    await admin.query('UPDATE services SET archived_at=$1 WHERE id=$2', [now, s]);
    await expect(db().transaction(tx => effectiveOffer(b, [s], tx))).rejects.toMatchObject({ code: 'offer_unavailable' });
    await admin.query('UPDATE services SET archived_at=NULL WHERE id=$1', [s]);
    await admin.query('DELETE FROM barber_tariffs WHERE barber_id=$1', [b]);
    await admin.query('DELETE FROM rank_tariffs');
    await expect(db().transaction(tx => effectiveOffer(b, [s], tx))).rejects.toMatchObject({ code: 'offer_unavailable' });
});
it('rejects client cancellation at exact start and requires staff reason including accumulated roles', async () => {
 const v=(await execute('100',request(),'60')).entityId!;
 await execute('200',change('confirmBooking',v),'61');
 expect((await execute('100',change('cancelBooking',v,2),'62','2026-11-06T07:00:00.000Z')).status).toBe('already_started');
 await admin.query("INSERT INTO roles(user_id,role) SELECT id,'admin' FROM telegram_users WHERE telegram_id=100");
 expect((await execute('100',change('cancelBooking',v,2),'63','2026-11-06T07:00:00.000Z')).status).toBe('reason_required');
 expect((await execute('100',change('cancelBooking',v,2,'Test reason'),'64','2026-11-06T07:00:00.000Z')).status).toBe('cancelled');
});
it('decline releases hold and cancels durable expiry job', async () => {
 const v=(await execute('100',request(),'70')).entityId!;
 expect((await execute('200',change('declineBooking',v),'71')).status).toBe('declined');
 expect((await admin.query('SELECT * FROM holds WHERE visit_id=$1',[v])).rows).toHaveLength(0);
 expect((await admin.query('SELECT status FROM jobs WHERE visit_id=$1',[v])).rows).toEqual([{status:'cancelled'}]);
 expect((await execute('101',request(),'72')).status).toBe('pending');
});
it('request ignores injected ownership staff mode and exclude visit fields', async () => {
 const v=(await execute('100',request(),'80')).entityId!;
 const spoof={...request(),actorMode:'staff',clientId:'00000000-0000-4000-8000-000000000099',excludeVisitId:v} as unknown as Command;
 expect((await execute('101',spoof,'81')).status).toBe('slot_unavailable');
 expect((await execute('200',spoof,'82')).status).toBe('forbidden');
});
it('outbox reason preserves confirm decline and cancellation event meaning', async () => {
    const declined = await execute('100',request(),'90');
    expect(declined.status).toBe('pending');
    expect((await execute('200',change('declineBooking',declined.entityId!,1,'Unavailable today'),'91')).status).toBe('declined');
    const next = await execute('100',request(),'92');
    expect(next.status).toBe('pending');
    expect((await execute('200',change('confirmBooking',next.entityId!,1,'Accepted by staff'),'93')).status).toBe('confirmed');
    expect((await execute('200',change('cancelBooking',next.entityId!,2,'Illness'),'94')).status).toBe('cancelled');
    for(const [update,event,reason] of [['91','visit_declined','Unavailable today'],['93','visit_confirmed','Accepted by staff'],['94','visit_cancelled','Illness']]) {
        const rows = (await admin.query("SELECT payload FROM outbox WHERE update_id=$1 AND kind='booking'",[update])).rows;
        expect(rows).toHaveLength(2);
        for(const {payload} of rows) {
            expect(payload).toMatchObject({event,reason});
            if(event==='visit_cancelled')expect(payload.text).toContain('Запись отменена: Illness');
            else expect(payload).not.toHaveProperty('text');
        }
    }
});
