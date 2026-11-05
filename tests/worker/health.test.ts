import { env } from 'cloudflare:workers';
import { createExecutionContext, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { probeDatabase } from '../../src/worker';
import type { Env } from '../../src/env';

const bindings = env as unknown as Env;
const call = (request: Request, config = bindings) => worker.fetch(request, config, createExecutionContext());
function update(text: string, sender = 100): Request {
  return new Request('https://example.test/webhook', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: 1,
      from: { id: sender, is_bot: false, first_name: 'Test' },
      chat: { id: sender, type: 'private', first_name: 'Test' }, text,
      entities: [{ offset: 0, length: text.length, type: 'bot_command' }] } }),
  });
}
const sqlResult = () => Response.json({ fields: [{ name: 'ok', dataTypeID: 23 }], rows: [['1']], rowCount: 1, command: 'SELECT', rowAsArray: true });
afterEach(() => vi.restoreAllMocks());

describe('Stage 1 deployment probe', () => {
  // Removing health's early return would expose invalid database config or trigger fetch.
  it('health_has_no_db_dependency', async () => {
    const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not call external services'));
    const response = await call(new Request('https://example.test/health'), { ...bindings, DATABASE_URL: '', BOT_INFO: '' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(http).not.toHaveBeenCalled();
  });

  // Moving authentication after parsing/config/handlers would allow side effects or return 400/500.
  it('rejects_wrong_webhook_secret', async () => {
    const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('forbidden side effect'));
    for (const secret of [null, 'wrong-secret']) {
      const headers: Record<string, string> = secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {};
      const response = await call(new Request('https://example.test/webhook', { method: 'POST', headers, body: 'not-json' }));
      expect(response.status).toBe(403);
    }
    expect(http).not.toHaveBeenCalled();
  });

  // More queries, leaked exceptions, or missing timeout would break this boundary contract.
  it('database_probe_is_bounded', async () => {
    const requests: { input: string; init?: RequestInit }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push({ input: String(input), init });
      return sqlResult();
    });
    expect(await probeDatabase(bindings.DATABASE_URL)).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ query: 'SELECT 1 AS ok', params: [] });
    expect(requests[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns_sanitized_database_failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(bindings.DATABASE_URL));
    expect(await probeDatabase(bindings.DATABASE_URL)).toEqual({ ok: false });
  });

  it('aborts_a_stalled_database_request', async () => {
    let aborted = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('fake-password')); }, { once: true });
    }));
    const started = Date.now();
    expect(await probeDatabase(bindings.DATABASE_URL)).toEqual({ ok: false });
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(4500);
  }, 5000);

  it('start_selects_once_then_sends_safe_telegram_reply', async () => {
    const destinations: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input); destinations.push(url);
      if (url.includes('neon.tech')) return sqlResult();
      expect(url).toBe('https://api.telegram.org/bot123456:test-token/sendMessage');
      expect(JSON.parse(String(init?.body))).toMatchObject({ chat_id: 100 });
      expect(String(init?.body)).not.toContain('fake-password');
      return Response.json({ ok: true, result: { message_id: 2, date: 1, chat: { id: 100, type: 'private' }, text: 'ok' } });
    });
    expect((await call(update('/start'))).status).toBe(200);
    expect(destinations).toHaveLength(2);
    expect(destinations[0]).toContain('neon.tech');
  });

  it('provider_errors_do_not_escape_webhook', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fake-password test-token'));
    const response = await call(update('/start'));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Service unavailable');
  });

  it('non_admin_cannot_arm_probe', async () => {
    const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not call'));
    expect((await call(update('/probe', 200))).status).toBe(200);
    const stub = bindings.SCHEDULER.get(bindings.SCHEDULER.idFromName('deployment-probe'));
    expect(await (await stub.fetch('https://probe/status')).json()).toMatchObject({ nextAlarm: null, lastAlarmAt: null });
    expect(http).not.toHaveBeenCalled();
  });

  it('admin_probe_arms_real_durable_object_and_records_alarm_without_database', async () => {
    const http = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true, result: { message_id: 2, date: 1, chat: { id: 100, type: 'private' }, text: 'ok' } }));
    expect((await call(update('/probe'))).status).toBe(200);
    const stub = bindings.SCHEDULER.get(bindings.SCHEDULER.idFromName('deployment-probe'));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const status = await (await stub.fetch('https://probe/status')).json() as { lastAlarmAt: number };
    expect(status.lastAlarmAt).toBeGreaterThan(0);
    expect(http).toHaveBeenCalledTimes(1); // Telegram acknowledgement only, no Neon.
  });
});
