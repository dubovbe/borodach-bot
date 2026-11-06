import type { Tx } from '../db/client';
import { DomainError, type Command, type CommandResult, type Id, type Instant } from '../domain/types';
import { effectiveOffer } from '../catalog/service';
import { approvalDeadline, busyIntervals, loadSchedule, slotsInTx, validateSchedule, workBetween } from '../schedule/service';
function refuse(code: string): never { throw new DomainError(code, 'Действие недоступно. Обновите данные.'); }
export type Context = {
    tx: Tx;
    userId: Id;
    updateId: Id;
};
const stamp = (v: Date | string) => new Date(v).toISOString();
export async function nextDue(tx: Tx): Promise<Instant | null> {
    const rows = await tx.query<{
        due: Date | string | null;
    }>(`SELECT min(due) AS due FROM (
 SELECT CASE WHEN status='leased' THEN GREATEST(due_at,COALESCE(lease_until,due_at)) ELSE due_at END AS due FROM jobs WHERE status IN ('pending','leased')
 UNION ALL SELECT GREATEST(due_at,COALESCE(lease_until,due_at)) FROM outbox WHERE sent_at IS NULL) q`, []);
    return rows[0]?.due ? stamp(rows[0].due) : null;
}
async function event(c: Context, kind: string, entityId: Id, visitId: Id, reason?: string): Promise<void> {
    const { tx, userId, updateId } = c;
    await tx.query('INSERT INTO audit_events(update_id,actor_id,kind,entity_id,data,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)', [updateId, userId, kind, entityId, JSON.stringify({ visitId, ...(reason ? { reason } : {}) }), tx.now]);
    const recipients = await tx.query<{
        telegram_id: string;
    }>(`SELECT u.telegram_id::text FROM visits v JOIN clients c ON c.id=v.client_id JOIN telegram_users u ON u.id=c.user_id WHERE v.id=$1
 UNION SELECT u.telegram_id::text FROM visits v JOIN barbers b ON b.id=v.barber_id JOIN telegram_users u ON u.id=b.user_id WHERE v.id=$1`, [visitId]);
    for (const recipient of recipients)
        await tx.query(`INSERT INTO outbox(logical_key,update_id,kind,chat_id,payload,due_at) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(logical_key) DO NOTHING`, [`${kind}:${entityId}:${updateId}:${recipient.telegram_id}`, updateId, 'booking', recipient.telegram_id, JSON.stringify({ event: kind, visitId, ...(reason ? { reason } : {}), ...(kind === 'visit_cancelled' && reason ? { text: `Приносим извинения. Запись отменена: ${reason}. Вы можете записаться снова.` } : {}) }), tx.now]);
}
async function cancelJobs(tx: Tx, visitId: Id): Promise<void> { await tx.query("UPDATE jobs SET status='cancelled',version=version+1 WHERE visit_id=$1 AND status IN ('pending','leased')", [visitId]); }
async function closeTransfers(c: Context, visitId: Id): Promise<void> {
    const rows = await c.tx.query<{
        id: string;
    }>("UPDATE transfers SET status='cancelled',version=version+1 WHERE visit_id=$1 AND status='pending' RETURNING id", [visitId]);
    for (const r of rows)
        await event(c, 'transfer_cancelled', r.id, visitId);
    await c.tx.query('DELETE FROM holds WHERE visit_id=$1 AND kind=$2', [visitId, 'transfer']);
}
// Called before the business savepoint. Expiry survives an expected refusal, but not infrastructure failure.
export async function cleanupExpired(c: Context): Promise<void> {
    const rows = await c.tx.query<{
        id: string;
    }>("UPDATE visits SET status='expired',version=version+1 WHERE status='pending' AND deadline<=$1 RETURNING id", [c.tx.now]);
    for (const row of rows) {
        await c.tx.query('DELETE FROM holds WHERE visit_id=$1', [row.id]);
        await cancelJobs(c.tx, row.id);
        await closeTransfers(c, row.id);
        await event(c, 'visit_expired', row.id, row.id);
    }
    const transfers = await c.tx.query<{
        id: string;
        visit_id: string;
    }>("UPDATE transfers SET status='expired',version=version+1 WHERE status='pending' AND deadline<=$1 RETURNING id,visit_id", [c.tx.now]);
    for (const row of transfers) {
        await c.tx.query('DELETE FROM holds WHERE transfer_id=$1', [row.id]);
        await c.tx.query("UPDATE jobs SET status='cancelled',version=version+1 WHERE visit_id=$1 AND status IN ('pending','leased') AND payload->>'transferId'=$2", [row.visit_id, row.id]);
        await event(c, 'transfer_expired', row.id, row.visit_id);
    }
}
export async function executeBooking(c: Context, command: Exclude<Command, {
    kind: 'start';
}>): Promise<CommandResult> {
    const { tx, userId } = c;
    const roles = await tx.query<{
        role: string;
    }>('SELECT role FROM roles WHERE user_id=$1', [userId]);
    const admin = roles.some(r => r.role === 'admin');
    if (command.kind === 'changeSchedule') {
        if (!admin)
            refuse('forbidden');
        validateSchedule(command.schedule);
        const barber = (await tx.query<{
            version: number;
        }>('SELECT version FROM barbers WHERE id=$1', [command.barberId]))[0];
        if (!barber)
            refuse('not_found');
        if (barber.version !== command.expectedVersion)
            refuse('stale_version');
        const busy = await busyIntervals(command.barberId, tx);
        for (const b of busy) {
            const work = workBetween(command.schedule, b.start, b.end);
            if (!work.some(w => Date.parse(w.start) <= Date.parse(b.start) && Date.parse(w.end) >= Date.parse(b.end)))
                refuse('schedule_conflict');
        }
        await tx.query('DELETE FROM weekly_hours WHERE barber_id=$1', [command.barberId]);
        await tx.query('DELETE FROM date_exceptions WHERE barber_id=$1', [command.barberId]);
        for (const [weekday, intervals] of Object.entries(command.schedule.weekly))
            for (const i of intervals)
                await tx.query('INSERT INTO weekly_hours(barber_id,weekday,start_minute,end_minute) VALUES($1,$2,$3,$4)', [command.barberId, Number(weekday), i.startMinute, i.endMinute]);
        for (const [date, intervals] of Object.entries(command.schedule.exceptions))
            await tx.query('INSERT INTO date_exceptions(barber_id,local_date,intervals) VALUES($1,$2,$3::jsonb)', [command.barberId, date, JSON.stringify(intervals)]);
        await tx.query('UPDATE barbers SET version=version+1 WHERE id=$1', [command.barberId]);
        await tx.query('INSERT INTO audit_events(update_id,actor_id,kind,entity_id,created_at) VALUES($1,$2,$3,$4,$5)', [c.updateId, userId, 'schedule_changed', command.barberId, tx.now]);
        return { entityId: command.barberId, status: 'schedule_changed', nextWake: await nextDue(tx) };
    }
    if (command.kind === 'requestBooking') {
        const client = (await tx.query<{
            id: string;
        }>('SELECT id FROM clients WHERE user_id=$1', [userId]))[0];
        if (!client || !roles.some(r => r.role === 'client'))
            refuse('forbidden');
        const pending = await tx.query<{
            id: string;
        }>(`SELECT id FROM visits WHERE client_id=$1 AND status='pending' AND deadline>$2
 UNION SELECT t.id FROM transfers t JOIN visits v ON v.id=t.visit_id WHERE v.client_id=$1 AND t.initiator='client' AND t.status='pending' AND t.deadline>$2`, [client.id, tx.now]);
        if (pending.length)
            refuse('pending_limit');
        if (!Number.isFinite(Date.parse(command.start)))
            refuse('slot_unavailable');
        const start = stamp(command.start);
        const slots = await slotsInTx({ barberId: command.barberId, serviceIds: command.serviceIds, from: start, to: start, actorMode: 'client' }, tx);
        const slot = slots.find(s => s.start === start);
        if (!slot)
            refuse('slot_unavailable');
        const offer = await effectiveOffer(command.barberId, command.serviceIds, tx);
        const schedule = await loadSchedule(command.barberId, tx);
        const deadline = approvalDeadline(tx.now, workBetween(schedule, tx.now, slot.end));
        if (!deadline || Date.parse(deadline) >= Date.parse(start))
            refuse('slot_unavailable');
        const visit = (await tx.query<{
            id: string;
        }>('INSERT INTO visits(client_id,barber_id,status,start_at,end_at,deadline,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id', [client.id, command.barberId, 'pending', start, slot.end, deadline, tx.now]))[0];
        for (const item of offer.items)
            await tx.query('INSERT INTO visit_items(visit_id,service_id,name,price_kopecks,duration_minutes) VALUES($1,$2,$3,$4,$5)', [visit.id, item.serviceId, item.name, item.priceKopecks, item.durationMinutes]);
        await tx.query('INSERT INTO holds(visit_id,barber_id,kind,start_at,end_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [visit.id, command.barberId, 'visit', start, slot.end, deadline]);
        await tx.query('INSERT INTO jobs(logical_key,kind,visit_id,entity_version,due_at) VALUES($1,$2,$3,$4,$5)', [`expire:${visit.id}:1`, 'expire_visit', visit.id, 1, deadline]);
        await event(c, 'visit_pending', visit.id, visit.id);
        return { entityId: visit.id, status: 'pending', nextWake: await nextDue(tx) };
    }
    const visit = (await tx.query<{
        id: string;
        client_user_id: string | null;
        barber_user_id: string | null;
        status: string;
        version: number;
        start_at: Date | string;
        deadline: Date | string | null;
    }>(`SELECT v.*,c.user_id AS client_user_id,b.user_id AS barber_user_id FROM visits v JOIN clients c ON c.id=v.client_id JOIN barbers b ON b.id=v.barber_id WHERE v.id=$1`, [command.visitId]))[0];
    if (!visit)
        refuse('not_found');
    const staff = admin || (visit.barber_user_id === userId && roles.some(r => r.role === 'barber'));
    const owner = visit.client_user_id === userId;
    if (command.kind === 'cancelBooking' ? (!owner && !staff) : !staff)
        refuse('forbidden');
    if (!Number.isInteger(command.expectedVersion) || visit.version !== command.expectedVersion)
        refuse('stale_version');
    let status: string;
    if (command.kind === 'confirmBooking') {
        if (visit.status !== 'pending' || !visit.deadline || Date.parse(stamp(visit.deadline)) <= Date.parse(tx.now))
            refuse('invalid_state');
        status = 'confirmed';
        await tx.query('UPDATE holds SET expires_at=NULL,version=version+1 WHERE visit_id=$1 AND kind=$2', [visit.id, 'visit']);
        await cancelJobs(tx, visit.id);
    }
    else if (command.kind === 'declineBooking') {
        if (visit.status !== 'pending')
            refuse('invalid_state');
        status = 'declined';
    }
    else {
        if (!['pending', 'confirmed'].includes(visit.status))
            refuse('invalid_state');
        const beforeStart = Date.parse(stamp(visit.start_at)) > Date.parse(tx.now);
        const asClient = owner && beforeStart;
        if (!asClient && !staff)
            refuse('already_started');
        // Before start an owner may use client rights; otherwise staff rights require a reason.
        if (!asClient && !command.reason?.trim())
            refuse('reason_required');
        status = 'cancelled';
    }
    if (status !== 'confirmed') {
        await tx.query('DELETE FROM holds WHERE visit_id=$1', [visit.id]);
        await cancelJobs(tx, visit.id);
        await closeTransfers(c, visit.id);
    }
    await tx.query('UPDATE visits SET status=$1,version=version+1 WHERE id=$2', [status, visit.id]);
    await event(c, `visit_${status}`, visit.id, visit.id, command.reason?.trim());
    return { entityId: visit.id, status, nextWake: await nextDue(tx) };
}
