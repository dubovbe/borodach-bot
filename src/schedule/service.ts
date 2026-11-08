import { DomainError, type Id, type Instant, type Interval, type WorkSchedule } from '../domain/types';
import type { Database, SqlReader, Tx } from '../db/client';
import { effectiveOffer } from '../catalog/service';
const minute = 60000, day = 86400000;
const localFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
export function localDate(instant: Instant): string { const parts = localFormatter.formatToParts(new Date(instant)); return ['year', 'month', 'day'].map(k => parts.find(p => p.type === k)!.value).join('-'); }
const midnight = (date: string) => Date.parse(`${date}T00:00:00+03:00`);
const iso = (ms: number) => new Date(ms).toISOString();
export function approvalDeadline(now: Instant, work: Interval[]): Instant | null {
    const n = Date.parse(now);
    let previous = -Infinity;
    for (const w of work) {
        const s = Date.parse(w.start), e = Date.parse(w.end);
        if (!Number.isFinite(s) || !Number.isFinite(e) || s >= e || s < previous)
            throw new DomainError('invalid_schedule', 'Некорректный график.');
        previous = e;
    }
    const next = work.find(w => Date.parse(w.end) > n);
    return next ? iso(Math.max(n, Date.parse(next.start)) + 60 * minute) : null;
}
export function validateSchedule(schedule: WorkSchedule): void {
    if (!schedule||typeof schedule!=='object'||!schedule.weekly||typeof schedule.weekly!=='object'||Array.isArray(schedule.weekly)||!schedule.exceptions||typeof schedule.exceptions!=='object'||Array.isArray(schedule.exceptions)||schedule.timezone !== 'Europe/Moscow')
        throw new DomainError('invalid_schedule', 'Некорректный часовой пояс.');
    const validate = (intervals: {
        startMinute: number;
        endMinute: number;
    }[]) => { if(!Array.isArray(intervals))throw new DomainError('invalid_schedule','Некорректные интервалы.');let end = -1; for (const i of intervals) {
        if (!i||typeof i!=='object'||!Number.isInteger(i.startMinute) || !Number.isInteger(i.endMinute) || i.startMinute < 0 || i.endMinute > 1440 || i.startMinute >= i.endMinute || i.startMinute < end)
            throw new DomainError('invalid_schedule', 'Некорректные интервалы.');
        end = i.endMinute;
    } };
    for (const [weekday, intervals] of Object.entries(schedule.weekly)) {
        if (!/^[1-7]$/.test(weekday))
            throw new DomainError('invalid_schedule', 'Некорректный день.');
        validate(intervals);
    }
    for (const [date, intervals] of Object.entries(schedule.exceptions)) {
        if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)
            throw new DomainError('invalid_schedule', 'Некорректная дата.');
        validate(intervals);
    }
}
export async function loadSchedule(barberId: Id, sql: SqlReader): Promise<WorkSchedule> {
    const weekly = await sql.query<{
        weekday: number;
        start_minute: number;
        end_minute: number;
    }>('SELECT weekday,start_minute,end_minute FROM weekly_hours WHERE barber_id=$1 ORDER BY weekday,start_minute', [barberId]);
    const exceptions = await sql.query<{
        local_date: string;
        intervals: {
            startMinute: number;
            endMinute: number;
        }[];
    }>('SELECT local_date::text,intervals FROM date_exceptions WHERE barber_id=$1', [barberId]);
    const schedule: WorkSchedule = { timezone: 'Europe/Moscow', weekly: {}, exceptions: {} };
    for (const row of weekly)
        (schedule.weekly[row.weekday] ??= []).push({ startMinute: row.start_minute, endMinute: row.end_minute });
    for (const row of exceptions)
        schedule.exceptions[row.local_date] = row.intervals;
    validateSchedule(schedule);
    return schedule;
}
function* scheduledWork(schedule: WorkSchedule, from: Instant, to: Instant): Generator<Interval> {
    validateSchedule(schedule);
    for (let d = midnight(localDate(from)), end = midnight(localDate(to)); d <= end; d += day) {
        const date = localDate(iso(d));
        const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
        for (const w of schedule.exceptions[date] ?? schedule.weekly[weekday] ?? [])
            yield { start: iso(d + w.startMinute * minute), end: iso(d + w.endMinute * minute) };
    }
}
export function workBetween(schedule: WorkSchedule, from: Instant, to: Instant): Interval[] { return [...scheduledWork(schedule, from, to)]; }
// Approval needs only the first still-relevant interval, never an expanded calendar of slots.
export function firstApprovalWork(schedule: WorkSchedule, now: Instant, to: Instant): Interval[] {
    for (const interval of scheduledWork(schedule, now, to)) if (Date.parse(interval.end) > Date.parse(now)) return [interval];
    return [];
}
export type SlotInput = {
    barberId: Id;
    serviceIds: Id[];
    from: Instant;
    to: Instant;
    actorMode: 'client' | 'staff';
    excludeVisitId?: Id;
};
function availabilityFor(input: Pick<SlotInput, 'from' | 'to' | 'actorMode'>, now: Instant, duration: number, schedule: WorkSchedule, busy: Interval[], horizon: number, firstPerDay: boolean): Interval[] {
    const from = Date.parse(input.from), to = Date.parse(input.to), n = Date.parse(now);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 366 * day)
        throw new DomainError('invalid_range', 'Некорректный диапазон.');
    const horizonEnd = midnight(localDate(now)) + (horizon + 1) * day;
    const upper = input.actorMode === 'client' ? Math.min(to, horizonEnd - 1) : to;
    const lower = Math.max(from, n + (input.actorMode === 'client' ? 120 * minute : 0));
    if (lower > upper)
        return [];
    const work = workBetween(schedule, iso(lower), iso(upper));
    const deadline = input.actorMode === 'client' ? approvalDeadline(now, firstApprovalWork(schedule, now, iso(upper))) : null;
    if (input.actorMode === 'client' && !deadline)
        return [];
    const slots: Interval[] = [];
    const found = new Set<string>();
    for (const w of work) {
        const date = localDate(w.start);
        if (firstPerDay && found.has(date)) continue;
        const start = Math.max(Date.parse(w.start), lower), end = Date.parse(w.end);
        const base = midnight(localDate(iso(start)));
        for (let s = base + Math.ceil((start - base) / (30 * minute)) * 30 * minute; s <= upper && s + duration * minute <= end; s += 30 * minute) {
            const e = s + duration * minute;
            if ((input.actorMode === 'client' && Date.parse(deadline!) >= s) || busy.some(b => Date.parse(b.start) < e && Date.parse(b.end) > s))
                continue;
            slots.push({ start: iso(s), end: iso(e) });
            if (firstPerDay) { found.add(date); break; }
        }
    }
    return slots;
}
export function slotsFor(input: Pick<SlotInput, 'from' | 'to' | 'actorMode'>, now: Instant, duration: number, schedule: WorkSchedule, busy: Interval[], horizon: number): Interval[] {
    return availabilityFor(input, now, duration, schedule, busy, horizon, false);
}
export function availableDaysFor(input: Pick<SlotInput, 'from' | 'to' | 'actorMode'>, now: Instant, duration: number, schedule: WorkSchedule, busy: Interval[], horizon: number): string[] {
    return availabilityFor(input, now, duration, schedule, busy, horizon, true).map(slot => localDate(slot.start));
}
export async function busyIntervals(barberId: Id, tx: Tx, excludeVisitId?: Id): Promise<Interval[]> {
    const rows = await tx.query<{
        start_at: Date | string;
        end_at: Date | string;
    }>(`SELECT start_at,end_at FROM holds WHERE barber_id=$1 AND (expires_at IS NULL OR expires_at>$2) AND ($3::uuid IS NULL OR visit_id<>$3)
 UNION SELECT start_at,end_at FROM visits WHERE barber_id=$1 AND (status='confirmed' OR(status='pending' AND deadline>$2)) AND ($3::uuid IS NULL OR id<>$3)
 UNION SELECT t.new_start_at,t.new_end_at FROM transfers t JOIN visits v ON v.id=t.visit_id WHERE v.barber_id=$1 AND t.status='pending' AND t.deadline>$2 AND ($3::uuid IS NULL OR v.id<>$3)`, [barberId, tx.now, excludeVisitId ?? null]);
    return rows.map(r => ({ start: new Date(r.start_at).toISOString(), end: new Date(r.end_at).toISOString() }));
}
export async function slotsInTx(input: SlotInput, tx: Tx): Promise<Interval[]> {
    const prepared=await prepareAvailability(input,tx);
    return prepared.slots(input);
}
// Explicit transaction-local preparation. No global cache, and no reuse across transactions.
export async function prepareAvailability(input:SlotInput,tx:Tx){
    const offer=await effectiveOffer(input.barberId,input.serviceIds,tx);
    const schedule=await loadSchedule(input.barberId,tx);
    const settings = await tx.query<{
        booking_horizon_days: number;
    }>('SELECT booking_horizon_days FROM settings WHERE shop_id=1', []);
    const busy=await busyIntervals(input.barberId,tx,input.excludeVisitId);
    const horizon=settings[0]?.booking_horizon_days??30;
    return {tx,barberId:input.barberId,serviceIds:[...input.serviceIds],offer,schedule,horizon,slots:(range:Pick<SlotInput,'from'|'to'|'actorMode'>)=>slotsFor(range,tx.now,offer.durationMinutes,schedule,busy,horizon),availableDays:(range:Pick<SlotInput,'from'|'to'|'actorMode'>)=>availableDaysFor(range,tx.now,offer.durationMinutes,schedule,busy,horizon)};
}
export async function listSlots(input: SlotInput, db: Database): Promise<Interval[]> {
    return db.read(async (sql) => {
        // One read-only snapshot; no shop mutation or application clock.
        await sql.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', []);
        try {
            const clock = await sql.query<{
                now: Date | string;
            }>('SELECT clock_timestamp() AS now', []);
            const result = await slotsInTx(input, { ...sql, now: new Date(clock[0].now).toISOString() });
            await sql.query('COMMIT', []);
            return result;
        }
        catch (error) {
            await sql.query('ROLLBACK', []);
            throw error;
        }
    });
}
import type {Conflict} from '../domain/types';
// Called under the repository shop lock. Historical ended intervals are never blockers.
export async function liveScheduleIntervals(barberId:Id,tx:Tx):Promise<Conflict[]>{
 const rows=await tx.query<{visit_id:string;kind:'visit'|'transfer';start_at:Date|string;end_at:Date|string}>(`SELECT visit_id,kind,start_at,end_at FROM (
 SELECT id AS visit_id,'visit'::text AS kind,start_at,end_at FROM visits WHERE barber_id=$1 AND end_at>$2 AND (status='confirmed' OR (status='pending' AND deadline>$2))
 UNION SELECT v.id,'transfer',t.new_start_at,t.new_end_at FROM transfers t JOIN visits v ON v.id=t.visit_id WHERE v.barber_id=$1 AND t.status='pending' AND t.deadline>$2 AND t.new_end_at>$2
 UNION SELECT visit_id,kind,start_at,end_at FROM holds WHERE barber_id=$1 AND end_at>$2 AND (expires_at IS NULL OR expires_at>$2)
 ) busy ORDER BY start_at,end_at,kind,visit_id`,[barberId,tx.now]);
 return rows.map(r=>({visitId:r.visit_id,kind:r.kind,start:new Date(r.start_at).toISOString(),end:new Date(r.end_at).toISOString()}));
}
export async function validateScheduleChange(barberId:Id,proposed:WorkSchedule,tx:Tx):Promise<Conflict[]>{
 validateSchedule(proposed);const busy=await liveScheduleIntervals(barberId,tx);
 return busy.filter(b=>!workBetween(proposed,b.start,b.end).some(w=>Date.parse(w.start)<=Date.parse(b.start)&&Date.parse(w.end)>=Date.parse(b.end)));
}
