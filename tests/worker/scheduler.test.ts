import { expect, it, vi } from 'vitest';
import { WakeScheduler } from '../../src/jobs/scheduler';
function harness(drain = vi.fn(async () => null as string | null)) {
    const values = new Map<string, unknown>();
    let alarm: number | null = null;
    const storage = { get: async (k: string) => values.get(k), put: async (k: string, v: unknown) => {
            values.set(k, v);
        },
        getAlarm: async () => alarm, setAlarm: async (n: number) => {
            alarm = n;
        }, deleteAlarm: async () => {
            alarm = null;
        },
        transaction: async (fn: (s: unknown) => unknown) => fn(storage) };
    const scheduler = new WakeScheduler(storage as never, drain, () => 10000);
    return { scheduler, storage, drain };
}
it('arm_preserves_earliest_under_interleaving', async () => {
    let finish!: (v: string | null) => void;
    const h = harness(vi.fn(() => new Promise<string | null>(r => {
        finish = r;
    })));
    await h.scheduler.arm(new Date(10000).toISOString());
    const running = h.scheduler.alarm();
    await vi.waitFor(() => expect(h.drain).toHaveBeenCalledOnce());
    await h.scheduler.arm(new Date(11000).toISOString());
    finish(new Date(90000).toISOString());
    await running;
    expect(await h.storage.getAlarm()).toBe(11000);
});
it('ensure_idle_does_not_query_neon', async () => {
    const h = harness();
    for (let i = 0; i < 1440; i++)
        await h.scheduler.ensure();
    expect(h.drain).not.toHaveBeenCalled();
    expect(await h.storage.getAlarm()).toBeNull();
});
it('alarm_failure_schedules_retry', async () => {
    const h = harness(vi.fn(async () => {
        throw Error('safe failure');
    }));
    await h.scheduler.arm(new Date(10000).toISOString());
    await h.scheduler.alarm();
    expect(await h.storage.getAlarm()).toBe(40000);
});
it('duplicate_alarm_does_not_duplicate_job_effect', async () => {
    let finish!: (v: null) => void;
    const h = harness(vi.fn(() => new Promise<null>(r => {
        finish = r;
    })));
    await h.scheduler.arm(new Date(10000).toISOString());
    const first = h.scheduler.alarm();
    await vi.waitFor(() => expect(h.drain).toHaveBeenCalledOnce());
    const duplicate = h.scheduler.alarm();
    finish(null);
    await Promise.all([first, duplicate]);
    expect(h.drain).toHaveBeenCalledOnce();
    expect(await h.storage.getAlarm()).toBeNull();
});
it('ensure_restores_missing_alarm_from_durable_state', async () => {
    const h = harness();
    await h.scheduler.arm(new Date(50000).toISOString());
    await h.storage.deleteAlarm();
    await h.scheduler.arm(null);
    await h.scheduler.ensure();
    expect(await h.storage.getAlarm()).toBe(50000);
});
it('storage_failure_rejects_once_and_next_alarm_can_recover', async () => {
    const h = harness();
    await h.scheduler.arm(new Date(10000).toISOString());
    const normal = h.storage.transaction;
    let fail = true;
    h.storage.transaction = async (fn) => {
        if (fail) {
            fail = false;
            throw Error('storage unavailable');
        }
        return normal(fn);
    };
    await expect(h.scheduler.alarm()).rejects.toThrow('storage unavailable');
    await h.scheduler.alarm();
    expect(h.drain).toHaveBeenCalledOnce();
    expect(await h.storage.getAlarm()).toBeNull();
});
