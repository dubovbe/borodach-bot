import pg from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { testDatabaseUrl } from './safety';
import { migrate } from '../../scripts/migrate';
import { seed } from '../../scripts/seed';
import { Repository } from '../../src/db/repository';
import { nodeDatabase } from '../../scripts/node-db';
import { DomainError } from '../../src/domain/types';
import type { Database } from '../../src/db/client';
import { createDatabase } from '../../src/db/client';

const url = testDatabaseUrl();
const schema = `stage2_${crypto.randomUUID().replaceAll('-', '')}`;
const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema}`);
let admin: pg.Client;
let created = false;
beforeAll(async () => {
  admin = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await migrate(scoped.toString());
  await seed(scoped.toString());
});
afterAll(async () => {
  if (created) {
    // This identifier is generated here, never obtained from env or user input.
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await admin?.end();
});

const database = () => nodeDatabase(scoped.toString());
const repo = () => new Repository(database(), '100');
const command = { kind: 'start', payload: null } as const;
const actor = { telegramId: '100' };
async function count(table: 'audit_events' | 'outbox' | 'processed_updates', updateId: string): Promise<number> {
  const result = await admin.query(`SELECT count(*)::integer AS n FROM "${schema}".${table} WHERE update_id=$1`, [updateId]);
  return result.rows[0].n;
}
function failingDatabase(error: Error): Database {
  const base = database();
  return { read: base.read.bind(base), transaction(run) {
    return base.transaction(async (tx) => {
      let failed = false;
      return run({ now: tx.now, async query<T>(sql: string, values: unknown[]): Promise<T[]> {
        const result = await tx.query<T>(sql,values);
        if (!failed && sql.startsWith('INSERT INTO outbox')) { failed = true; throw error; }
        return result;
      } });
    });
  } };
}
it('duplicate_update_returns_same_result', async () => {
  const first = await repo().execute(actor, command, '11');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await repo().execute(actor, command, '11');
  expect(second).toEqual(first); expect(first.status).toBe('started'); expect(first.nextWake).not.toBeNull();
  expect(await count('audit_events', '11')).toBe(1); expect(await count('outbox', '11')).toBe(1);
});
it('concurrent_duplicate_commits_once', async () => {
  const results = await Promise.all([repo().execute(actor, command, '12'), repo().execute(actor, command, '12')]);
  expect(results[0]).toEqual(results[1]); expect(await count('processed_updates', '12')).toBe(1);
  expect(await count('audit_events', '12')).toBe(1); expect(await count('outbox', '12')).toBe(1);
});
it('rollback_removes_event_and_outbox', async () => {
  await expect(new Repository(failingDatabase(new Error('injected failure'))).execute({ telegramId: '103' }, command, '13')).rejects.toThrow();
  for (const table of ['audit_events','outbox','processed_updates'] as const) expect(await count(table, '13')).toBe(0);
  expect((await admin.query(`SELECT count(*)::integer AS n FROM "${schema}".telegram_users WHERE telegram_id=$1`, ['103'])).rows[0].n).toBe(0);
});
it('domain_error_rolls_back_partial_business_changes_and_records_one_refusal', async () => {
  const result = await new Repository(failingDatabase(new DomainError('rejected', 'Safe refusal'))).execute(actor, command, '14');
  expect(result.status).toBe('rejected'); expect(await count('audit_events','14')).toBe(1);
  expect(await count('outbox','14')).toBe(1);
  const events = await admin.query(`SELECT kind FROM "${schema}".audit_events WHERE update_id=$1`, ['14']);
  expect(events.rows[0].kind).toBe('command_refused');
  expect(await repo().execute(actor, command, '14')).toEqual(result);
});

it('seed_is_idempotent_and_has_no_telegram_data', async () => {
  const before = await admin.query(`SELECT id,name FROM "${schema}".barbers ORDER BY id`);
  await seed(scoped.toString()); await seed(scoped.toString());
  expect((await admin.query(`SELECT id,name FROM "${schema}".barbers ORDER BY id`)).rows).toEqual(before.rows);
  expect((await admin.query(`SELECT user_id FROM "${schema}".barbers`)).rows).toEqual([{ user_id: null }]);
});
it('migration_repeat_is_noop_and_changed_checksum_is_rejected', async () => {
  const before = await admin.query(`SELECT * FROM "${schema}".schema_migrations`);
  await migrate(scoped.toString());
  expect((await admin.query(`SELECT * FROM "${schema}".schema_migrations`)).rows).toEqual(before.rows);
  await admin.query(`UPDATE "${schema}".schema_migrations SET checksum=$1`, ['changed']);
  try { await expect(migrate(scoped.toString())).rejects.toThrow('Migration checksum mismatch'); }
  finally { await admin.query(`UPDATE "${schema}".schema_migrations SET checksum=$1`, [before.rows[0].checksum]); }
});
it('missing_shop_lock_row_fails_explicitly_and_leaves_no_effect', async () => {
  await admin.query(`DELETE FROM "${schema}".settings`); await admin.query(`DELETE FROM "${schema}".shop`);
  try { await expect(repo().execute(actor, command, '15')).rejects.toThrow('Shop singleton is missing'); }
  finally { await seed(scoped.toString()); }
  expect(await count('processed_updates','15')).toBe(0);
});
it('database_clock_is_read_after_waiting_for_shop_lock', async () => {
  const blocker = new pg.Client({ connectionString: scoped.toString(), connectionTimeoutMillis: 5000 });
  await blocker.connect(); await blocker.query('BEGIN'); await blocker.query('SELECT id FROM shop WHERE id=$1 FOR UPDATE', [1]);
  const result = repo().execute({ telegramId: '101' }, command, '16');
  let boundary: Date;
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    boundary = (await blocker.query('SELECT clock_timestamp() AS now')).rows[0].now;
    await blocker.query('COMMIT');
  } finally { await blocker.end(); }
  expect(Date.parse((await result).nextWake!)).toBeGreaterThanOrEqual(boundary!.getTime());
});
it('delivery_is_separate_from_committed_result_and_replay_is_exact', async () => {
  const repository = repo();
  const result = await repository.execute(actor,command,'17');
  const message = await repository.pendingStart('17'); expect(message?.chatId).toBe('100');
  await repository.markSent(message!.id);
  expect(await repository.pendingStart('17')).toBeNull();
  expect(await repository.replay('17')).toEqual(result);
  expect(await repository.replay('999999')).toBeNull();
});
it.skipIf(!new URL(url).hostname.endsWith('.neon.tech'))('runtime_neon_websocket_transaction_and_replay', async () => {
  const repository = new Repository(createDatabase(scoped.toString()));
  const result = await repository.execute(actor,command,'18');
  expect(result.status).toBe('started');
  expect(await repository.execute(actor,command,'18')).toEqual(result);
  expect(await count('audit_events','18')).toBe(1); expect(await count('outbox','18')).toBe(1);
});
it('migration_creates_all_core_tables', async () => {
  const tables = ['shop','settings','telegram_users','roles','clients','phone_claims','barbers','ranks','services',
    'rank_tariffs','barber_tariffs','assignments','weekly_hours','date_exceptions','visits','visit_items','holds',
    'transfers','drafts','callbacks','invitations','processed_updates','audit_events','jobs','outbox'];
  const result = await admin.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [schema]);
  expect(result.rows.map((row) => row.tablename)).toEqual(expect.arrayContaining(tables));
});
