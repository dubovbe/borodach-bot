import type { Tx } from '../db/client';
import { DomainError, type Id, type OfferItem } from '../domain/types';
export async function effectiveOffer(barberId: Id, serviceIds: Id[], tx: Tx): Promise<{
    items: OfferItem[];
    priceKopecks: number;
    durationMinutes: number;
}> {
    if (!serviceIds.length || new Set(serviceIds).size !== serviceIds.length)
        throw new DomainError('offer_unavailable', 'Выберите доступные услуги.');
    const rows = await tx.query<{
        service_id: string;
        name: string;
        price_kopecks: number;
        duration_minutes: number;
    }>(`SELECT s.id AS service_id,s.name,
 COALESCE(bt.price_kopecks,rt.price_kopecks) AS price_kopecks,COALESCE(bt.duration_minutes,rt.duration_minutes) AS duration_minutes
 FROM barbers b JOIN assignments a ON a.barber_id=b.id JOIN services s ON s.id=a.service_id
 LEFT JOIN barber_tariffs bt ON bt.barber_id=b.id AND bt.service_id=s.id
 LEFT JOIN rank_tariffs rt ON rt.rank_id=b.rank_id AND rt.service_id=s.id
 WHERE b.id=$1 AND s.id=ANY($2::uuid[]) AND b.archived_at IS NULL AND s.archived_at IS NULL`, [barberId, serviceIds]);
    const items = serviceIds.map(id => {
        const row = rows.find(r => r.service_id === id);
        if (!row || !Number.isInteger(row.price_kopecks) || row.price_kopecks < 0 || !Number.isInteger(row.duration_minutes) || row.duration_minutes <= 0)
            throw new DomainError('offer_unavailable', 'Услуга недоступна.');
        return { serviceId: id, name: row.name, priceKopecks: row.price_kopecks, durationMinutes: row.duration_minutes };
    });
    const priceKopecks = items.reduce((n, i) => n + i.priceKopecks, 0), durationMinutes = items.reduce((n, i) => n + i.durationMinutes, 0);
    if (priceKopecks > 2147483647 || durationMinutes > 2147483647)
        throw new DomainError('offer_unavailable', 'Слишком большой состав услуг.');
    return { items, priceKopecks, durationMinutes };
}
