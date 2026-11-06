import { URL } from 'node:url';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { migrate } from '../../scripts/migrate';
import { testDatabaseUrl } from './safety';
import { seed } from '../../scripts/seed';
import { nodeDatabase } from '../../scripts/node-db';
import { Outbox } from '../../src/notifications/outbox';
it('upgrade_001_preserves_sent_and_legacy_start_and_booking_rows', async () => {
    const url = testDatabaseUrl(), schema = `upgrade4_${crypto.randomUUID().replaceAll('-', '')}`;
    const scoped = new URL(url);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await client.connect();
    let created = false;
    try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        created = true;
        await client.query(`SET search_path TO "${schema}"`);
        const sql = await readFile(new URL('../../src/db/schema/001-core.sql', import.meta.url), 'utf8');
        await client.query(sql);
        await client.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
        await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', ['001-core.sql', createHash('sha256').update(sql).digest('hex')]);
        await client.query(`INSERT INTO outbox(logical_key,update_id,kind,chat_id,payload,due_at,sent_at) VALUES('sent',1,'start',100,'{"text":"legacy"}',clock_timestamp(),clock_timestamp()),('pending',2,'start',100,'{"text":"pending legacy"}',clock_timestamp(),NULL),('invalidbooking',3,'booking',100,'{"event":"visit_confirmed","visitId":"bad-id"}',clock_timestamp(),NULL)`);
        await seed(scoped.toString());
        const clientId = (await client.query("INSERT INTO clients(name) VALUES('Legacy client') RETURNING id")).rows[0].id;
        const barberId = (await client.query('SELECT id FROM barbers LIMIT 1')).rows[0].id;
        const visitId = (await client.query(`INSERT INTO visits(client_id,barber_id,status,start_at,end_at,created_at,version) VALUES($1,$2,'confirmed','2026-11-07T10:00:00Z','2026-11-07T10:45:00Z',clock_timestamp(),2) RETURNING id`, [clientId, barberId])).rows[0].id;
        await client.query("INSERT INTO visit_items(visit_id,service_id,name,price_kopecks,duration_minutes) SELECT $1,id,'Снимок услуги',123400,45 FROM services LIMIT 1", [visitId]);
        await client.query("UPDATE services SET name='Changed catalog'; UPDATE rank_tariffs SET price_kopecks=1,duration_minutes=1");
        await client.query(`INSERT INTO outbox(logical_key,update_id,kind,chat_id,payload,due_at) VALUES('booking',4,'booking',100,$1::jsonb,clock_timestamp())`, [JSON.stringify({ event: 'visit_confirmed', visitId })]);
        await migrate(scoped.toString());
        await migrate(scoped.toString());
        expect((await client.query('SELECT logical_key,status FROM outbox ORDER BY logical_key')).rows).toEqual([{ logical_key: 'booking', status: 'pending' }, { logical_key: 'invalidbooking', status: 'failed' }, { logical_key: 'pending', status: 'pending' }, { logical_key: 'sent', status: 'sent' }]);
        expect((await client.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n).toBe(2);
        expect((await client.query("SELECT entity_id,entity_version,entity_type FROM outbox WHERE logical_key='booking'")).rows[0]).toMatchObject({ entity_id: visitId, entity_version: 2, entity_type: 'visit' });
        const texts: string[] = [];
        await new Outbox(nodeDatabase(scoped.toString()), { send: async (delivery) => {
                texts.push((delivery.payload as {
                    text: string;
                }).text);
                return { messageId: 'legacy-test' };
            } }).deliver(new Date().toISOString(), 5);
        expect((await client.query("SELECT status FROM outbox WHERE logical_key='booking'")).rows[0].status).toBe('sent');
        const bookingText = texts.find(text => text.includes('Запись подтверждена'));
        expect(bookingText).toContain('Снимок услуги');
        expect(bookingText).toContain('1234');
        expect(bookingText).toContain('45 мин.');
        expect(bookingText).toContain('Вымышленный мастер');
        expect(bookingText).toContain('Вымышленная улица, 1');
        expect(bookingText).toContain('07.11.2026');
        expect(bookingText).not.toContain('Changed catalog');
    }
    finally {
        if (created)
            await client.query(`DROP SCHEMA "${schema}" CASCADE`);
        await client.end();
    }
}, 60000);
