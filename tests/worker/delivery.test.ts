import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { expect, it, vi, afterEach } from 'vitest';
import type { Env } from '../../src/env';
import { CloudflareScheduler } from '../../src/jobs/scheduler';
const state = vi.hoisted(() => ({ executed: 0, effects: 0 }));
vi.mock('../../src/db/repository', () => ({ Repository: class {
        async execute() {
            state.executed++;
            if (state.effects === 0)
                state.effects++;
            return { status: 'started', nextWake: '2026-11-06T00:00:00.000Z' };
        }
    } }));
import worker from '../../src/worker';
const bindings = env as unknown as Env;
const request = () => new Request('https://test/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': bindings.WEBHOOK_SECRET }, body: JSON.stringify({ update_id: 8, message: { message_id: 1, date: 1, text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }], from: { id: 100, is_bot: false, first_name: 'Test' }, chat: { id: 100, type: 'private' } } }) });
afterEach(() => {
    vi.restoreAllMocks();
    state.executed = 0;
    state.effects = 0;
});
it('failed_arm_retries_without_repeating_command', async () => {
    const arm = vi.spyOn(CloudflareScheduler.prototype, 'arm').mockRejectedValueOnce(Error('unavailable')).mockResolvedValue();
    const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('no direct delivery'));
    expect((await worker.fetch(request(), bindings, createExecutionContext())).status).toBe(503);
    expect(state.effects).toBe(1);
    expect((await worker.fetch(request(), bindings, createExecutionContext())).status).toBe(200);
    expect(state.effects).toBe(1);
    expect(arm).toHaveBeenCalledTimes(2);
    expect(http).not.toHaveBeenCalled();
});
