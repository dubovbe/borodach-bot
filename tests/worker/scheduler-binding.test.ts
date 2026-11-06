import { env } from 'cloudflare:workers';
import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@neondatabase/serverless';
import worker from '../../src/worker';
import type { Env } from '../../src/env';
const bindings = env as unknown as Env;
afterEach(() => vi.restoreAllMocks());
it('cron_1440_idle_ticks_never_connect_to_neon', async () => {
    const sql = vi.spyOn(Client.prototype, 'connect').mockRejectedValue(Error('no idle SQL'));
    for (let i = 0; i < 1440; i++)
        await worker.scheduled({} as ScheduledController, bindings);
    expect(sql).not.toHaveBeenCalled();
});
it('actual_do_atomic_state_restores_alarm_and_null_arm_preserves_it', async () => {
    const stub = bindings.SCHEDULER.get(bindings.SCHEDULER.newUniqueId());
    const next = Date.now() + 600000;
    await stub.fetch('https://scheduler/arm', { method: 'POST', body: JSON.stringify({ nextWake: new Date(next).toISOString() }) });
    await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.deleteAlarm();
    });
    await stub.fetch('https://scheduler/arm', { method: 'POST', body: '{"nextWake":null}' });
    await stub.fetch('https://scheduler/ensure', { method: 'POST' });
    const status = await (await stub.fetch('https://scheduler/status')).json() as {
        nextAlarm: number;
    };
    expect(status.nextAlarm).toBe(next);
});
it('public_worker_has_no_arm_route', async () => {
    expect((await worker.fetch(new Request('https://test/arm', { method: 'POST', body: '{}' }), bindings, createExecutionContext())).status).toBe(404);
});
