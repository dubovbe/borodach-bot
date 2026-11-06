import { expect, it } from 'vitest';
import { effectiveOffer } from '../../src/catalog/service';
import type { Tx } from '../../src/db/client';
const row = (id: string, price = 100, minutes = 60) => ({ service_id: id, name: id, price_kopecks: price, duration_minutes: minutes });
const tx = (rows: unknown[]) => ({ now: '', query: async () => rows }) as Tx;
it('zero price with positive duration is allowed', async () => { expect((await effectiveOffer('b', ['a'], tx([row('a', 0, 45)]))).items[0]).toMatchObject({ priceKopecks: 0, durationMinutes: 45 }); });
it('sums 60 plus 30 minutes and kopecks preserving order', async () => {
    expect(await effectiveOffer('b', ['a', 'c'], tx([row('c', 200, 30), row('a')]))).toMatchObject({ priceKopecks: 300, durationMinutes: 90, items: [{ serviceId: 'a' }, { serviceId: 'c' }] });
});
it('missing tariff or assignment is unavailable', async () => { await expect(effectiveOffer('b', ['a'], tx([]))).rejects.toMatchObject({ code: 'offer_unavailable' }); });
it('rejects empty duplicate invalid and overflowing offers', async () => {
    for (const ids of [[], ['a', 'a']])
        await expect(effectiveOffer('b', ids, tx([]))).rejects.toThrow();
    for (const rows of [[row('a', -1)], [row('a', 1, 0)], [row('a', 2147483647), row('c', 1)]])
        await expect(effectiveOffer('b', rows.map(r => r.service_id), tx(rows))).rejects.toThrow();
});
