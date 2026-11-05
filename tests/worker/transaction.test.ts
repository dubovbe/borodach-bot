import { Client } from '@neondatabase/serverless';
import { afterEach, expect, it, vi } from 'vitest';
import { probeTransaction } from '../../src/db/probe-transaction';
afterEach(() => vi.restoreAllMocks());

// Boundary doubles replace only remote DB transport; assertions cover our transaction lifecycle.
it('interactive_probe_rolls_back_and_closes_client', async () => {
  const events: string[] = [];
  vi.spyOn(Client.prototype, 'connect').mockImplementation((async () => { events.push('connect'); }) as never);
  vi.spyOn(Client.prototype, 'query').mockImplementation((async (sql: string) => {
    events.push(sql); return { rows: [{ ok: 1 }] };
  }) as never);
  vi.spyOn(Client.prototype, 'end').mockImplementation(async () => { events.push('end'); });
  expect(await probeTransaction('postgresql://fake:fake@ep-test.neon.tech/test')).toEqual({ ok: true });
  expect(events).toEqual(['connect', 'BEGIN', 'SELECT 1 AS ok', 'ROLLBACK', 'end']);
});

it('interactive_failure_is_sanitized_and_still_closes_client', async () => {
  const events: string[] = [];
  vi.spyOn(Client.prototype, 'connect').mockImplementation((async () => { events.push('connect'); }) as never);
  vi.spyOn(Client.prototype, 'query').mockImplementation((async (sql: string) => {
    events.push(sql); if (sql.startsWith('SELECT')) throw new Error('fake-password');
    return { rows: [] };
  }) as never);
  vi.spyOn(Client.prototype, 'end').mockImplementation(async () => { events.push('end'); });
  expect(await probeTransaction('postgresql://fake:fake@ep-test.neon.tech/test')).toEqual({ ok: false });
  expect(events).toEqual(['connect', 'BEGIN', 'SELECT 1 AS ok', 'end']);
});

it('interactive_probe_deadline_closes_a_stalled_connection', async () => {
  let closed = false;
  vi.spyOn(Client.prototype, 'connect').mockImplementation((() => new Promise(() => {})) as never);
  vi.spyOn(Client.prototype, 'end').mockImplementation(async () => { closed = true; });
  const started = Date.now();
  expect(await probeTransaction('postgresql://fake:fake@ep-test.neon.tech/test')).toEqual({ ok: false });
  expect(closed).toBe(true);
  expect(Date.now() - started).toBeLessThan(8000);
}, 9000);
