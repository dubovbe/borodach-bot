import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { Client } from '@neondatabase/serverless';
import { afterEach, expect, it, vi } from 'vitest';
import { probeTransaction } from '../../src/db/probe-transaction';
import worker from '../../src/worker';
import type { Env } from '../../src/env';
afterEach(() => vi.restoreAllMocks());
function webhook(sender: number): Request {
  return new Request('https://example.test/webhook', { method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: 1,
      from: { id: sender, is_bot: false, first_name: 'Test' }, chat: { id: sender, type: 'private' },
      text: '/probe_db', entities: [{ type: 'bot_command', offset: 0, length: 9 }] } }),
  });
}

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

it('non_admin_probe_db_does_not_connect_or_call_telegram', async () => {
  const connect = vi.spyOn(Client.prototype, 'connect').mockRejectedValue(new Error('must not connect'));
  const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not fetch'));
  expect((await worker.fetch(webhook(200), env as unknown as Env, createExecutionContext())).status).toBe(200);
  expect(connect).not.toHaveBeenCalled();
  expect(http).not.toHaveBeenCalled();
});

it('admin_probe_db_runs_transaction_and_replies_safely', async () => {
  let connections = 0;
  vi.spyOn(Client.prototype, 'connect').mockImplementation((async () => { connections++; }) as never);
  vi.spyOn(Client.prototype, 'query').mockImplementation((async () => ({ rows: [{ ok: 1 }] })) as never);
  vi.spyOn(Client.prototype, 'end').mockResolvedValue(undefined);
  const replies: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    replies.push(String(init?.body));
    return Response.json({ ok: true, result: { message_id: 2, date: 1, chat: { id: 100, type: 'private' }, text: 'ok' } });
  });
  expect((await worker.fetch(webhook(100), env as unknown as Env, createExecutionContext())).status).toBe(200);
  expect(connections).toBe(1);
  expect(replies).toHaveLength(1);
  expect(replies[0]).not.toContain('fake-password');
});
