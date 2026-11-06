import { expect, it, vi } from 'vitest';
import { drainBatch } from '../../src/jobs/drain';
it('global_five_budget_includes_stale_jobs_and_failed_messages', async () => {
    const drainDue = vi.fn(async () => ({ processedCount: 4, remaining: false, nextWake: null }));
    const deliver = vi.fn(async (_now: string, limit: number) => {
        expect(limit).toBe(1);
        return { processedCount: 1, nextWake: null, remaining: false };
    });
    await drainBatch({ drainDue, nextDue: async () => null }, { deliver }, new Date().toISOString());
    expect(drainDue).toHaveBeenCalledWith(expect.any(String), 5);
    expect(deliver).toHaveBeenCalledOnce();
});
it('remaining_batch_waits_one_second_after_work_finishes', async () => {
    const now = '2026-11-06T00:00:00.000Z';
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now) + 9000);
    try {
        const result = await drainBatch({ drainDue: async () => ({ processedCount: 5, remaining: true, nextWake: now }), nextDue: async () => now }, { deliver: async () => ({ processedCount: 0, remaining: true, nextWake: now }) }, now);
        expect(result).toBe('2026-11-06T00:00:10.000Z');
    }
    finally {
        clock.mockRestore();
    }
});
