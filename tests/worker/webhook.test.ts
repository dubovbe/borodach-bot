import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@neondatabase/serverless';
import worker from '../../src/worker';
import type { Env } from '../../src/env';

const bindings = env as unknown as Env;
afterEach(() => vi.restoreAllMocks());
const start = () => new Request('https://test/webhook', { method: 'POST', headers: {
  'X-Telegram-Bot-Api-Secret-Token': bindings.WEBHOOK_SECRET }, body: JSON.stringify({ update_id: 7,
  message: { message_id: 1, date: 1, text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    from: { id: 100, is_bot: false, first_name: 'Test' }, chat: { id: 100, type: 'private' } } }) });

it('missing_or_bad_secret_never_enters_db', async () => {
  const connect = vi.spyOn(Client.prototype, 'connect').mockRejectedValue(new Error('secret'));
  const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('secret'));
  for (const secret of ['', 'wrong']) {
    const response = await worker.fetch(new Request('https://test/webhook', { method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: 'invalid JSON' }), bindings, createExecutionContext());
    expect(response.status).toBe(403);
  }
  expect(connect).not.toHaveBeenCalled(); expect(http).not.toHaveBeenCalled();
});

it('start_requires_interactive_transaction_before_delivery', async () => {
  const connect = vi.spyOn(Client.prototype, 'connect').mockRejectedValue(new Error('fake-password'));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).includes('neon.tech')
    ? Response.json({ fields: [{ name: 'ok', dataTypeID: 23 }], rows: [['1']], rowCount: 1, command: 'SELECT', rowAsArray: true })
    : Response.json({ ok: true, result: { message_id: 2 } }));
  expect((await worker.fetch(start(), bindings, createExecutionContext())).status).toBe(503);
  expect(connect).toHaveBeenCalledOnce();
});
