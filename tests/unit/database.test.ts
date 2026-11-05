import { expect, it, vi } from 'vitest';
import { databaseFromClients, type SqlClient } from '../../src/db/client';
import { assertIsolatedTestDatabase } from '../integration/safety';

function fixture() {
  const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT id') ? [{ id: 1 }] : sql.startsWith('SELECT clock') ? [{ now: new Date('2026-11-06T00:00:00Z') }] : [], rowCount: 1 }));
  const connect = vi.fn(async () => {}); const end = vi.fn(async () => {});
  const client = { query, connect, end } as unknown as SqlClient;
  return { query, connect, end, database: databaseFromClients({ createClient: () => client }) };
}
it('transaction_reads_database_clock_after_lock_and_commits_before_close', async () => {
  const f = fixture();
  const result = await f.database.transaction(async (tx) => tx.now);
  expect(result).toBe('2026-11-06T00:00:00.000Z');
  const statements = f.query.mock.calls.map(([sql]) => sql);
  expect(statements.indexOf('SELECT clock_timestamp() AS now')).toBeGreaterThan(statements.indexOf('SELECT id FROM shop WHERE id=$1 FOR UPDATE'));
  expect(statements.at(-1)).toBe('COMMIT'); expect(f.end).toHaveBeenCalledOnce();
});
it('unknown_failure_rolls_back_and_closes', async () => {
  const f = fixture();
  await expect(f.database.transaction(async () => { throw new Error('application failed'); })).rejects.toThrow('application failed');
  expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK'); expect(f.end).toHaveBeenCalledOnce();
});
it('failed_connection_is_closed', async () => {
  const f = fixture(); f.connect.mockRejectedValueOnce(new Error('connect failed'));
  await expect(f.database.read(async () => null)).rejects.toThrow('connect failed');
  expect(f.query).not.toHaveBeenCalled(); expect(f.end).toHaveBeenCalledOnce();
});
it('read_returns_rows_and_closes_without_transaction', async () => {
  const f = fixture(); await f.database.read(async (sql) => sql.query('SELECT value WHERE id=$1', ['test']));
  expect(f.query.mock.calls.map(([sql]) => sql)).toEqual(['SELECT value WHERE id=$1']); expect(f.end).toHaveBeenCalledOnce();
});
it('test_database_guard_fails_closed_and_normalizes_pooler_alias', () => {
  expect(() => assertIsolatedTestDatabase(undefined, [])).toThrow('required');
  expect(() => assertIsolatedTestDatabase('invalid', [])).toThrow('Invalid database URL');
  expect(() => assertIsolatedTestDatabase('https://test.example/db', [])).toThrow('PostgreSQL');
  expect(() => assertIsolatedTestDatabase('postgres://test@ep-same-pooler.example/db', ['postgres://runtime@ep-same.example/db'])).toThrow('hosts must differ');
  expect(assertIsolatedTestDatabase('postgres://test@ep-isolated.example/db', ['postgres://runtime@ep-same.example/db'])).toContain('ep-isolated');
});
