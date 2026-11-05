import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { expect, it, vi, afterEach } from 'vitest';
import type { Env } from '../../src/env';

const state = vi.hoisted(() => ({ executed: 0, effects: 0, sent: false, failMark: false }));
vi.mock('../../src/db/repository', () => ({ Repository: class {
  async execute() { state.executed++; if (state.effects === 0) state.effects++; return { status: 'started', nextWake: '2026-11-06T00:00:00.000Z' }; }
  async pendingStart() { return state.sent ? null : { id: 'persisted-message', chatId: '100', text: 'Тестовый бот запущен.' }; }
  async markSent() { if (state.failMark) throw new Error('mark unavailable'); state.sent = true; }
} }));
import worker from '../../src/worker';
const bindings = env as unknown as Env;
const request = () => new Request('https://test/webhook', { method: 'POST', headers: {
  'X-Telegram-Bot-Api-Secret-Token': bindings.WEBHOOK_SECRET }, body: JSON.stringify({ update_id: 8,
  message: { message_id: 1, date: 1, text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    from: { id: 100, is_bot: false, first_name: 'Test' }, chat: { id: 100, type: 'private' } } }) });
afterEach(() => { vi.restoreAllMocks(); state.executed = 0; state.effects = 0; state.sent = false; state.failMark = false; });

it('failed_arm_retries_without_repeating_command', async () => {
  const http = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('send unavailable'))
    .mockResolvedValue(Response.json({ ok: true, result: { message_id: 1 } }));
  expect((await worker.fetch(request(), bindings, createExecutionContext())).status).toBe(503);
  expect(state.effects).toBe(1); expect(state.sent).toBe(false);
  expect((await worker.fetch(request(), bindings, createExecutionContext())).status).toBe(200);
  expect(state.effects).toBe(1); expect(state.sent).toBe(true); expect(http).toHaveBeenCalledTimes(2);
  expect((await worker.fetch(request(), bindings, createExecutionContext())).status).toBe(200);
  expect(http).toHaveBeenCalledTimes(2);
});
it('failed_mark_is_retryable_and_ambiguous_send_may_repeat', async () => {
  const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ok: true, result: { message_id: 1 } }));
  state.failMark = true;
  expect((await worker.fetch(request(), bindings, createExecutionContext())).status).toBe(503);
  expect(state.sent).toBe(false); state.failMark = false;
  expect((await worker.fetch(request(), bindings, createExecutionContext())).status).toBe(200);
  expect(state.effects).toBe(1); expect(state.sent).toBe(true); expect(http).toHaveBeenCalledTimes(2);
});
