import { expect, it, vi } from 'vitest';
import { approvalDeadline, slotsFor, validateSchedule } from '../../src/schedule/service';
const now = '2026-11-06T06:00:00.000Z';
const interval = (a: string, b: string) => ({ start: `2026-11-06T${a}:00.000Z`, end: `2026-11-06T${b}:00.000Z` });
it('approval_deadline_continues_after_shift', () => { expect(approvalDeadline('2026-11-06T16:40:00.000Z', [interval('07:00', '17:00')])).toBe('2026-11-06T17:40:00.000Z'); });
it('outside or exact end uses next work start and no work returns null', () => {
    expect(approvalDeadline('2026-11-06T07:00:00.000Z', [interval('08:00', '09:00')])).toBe('2026-11-06T09:00:00.000Z');
    expect(approvalDeadline('2026-11-06T09:00:00.000Z', [interval('08:00', '09:00')])).toBeNull();
});
const schedule = { timezone: 'Europe/Moscow' as const, weekly: { 5: [{ startMinute: 541, endMinute: 840 }, { startMinute: 900, endMinute: 1200 }] }, exceptions: {} };
const input = { from: now, to: '2026-11-07T00:00:00.000Z', actorMode: 'client' as const };
it('local midnight grid with actual 45 minutes, breaks and adjacent holds', () => {
    const slots = slotsFor(input, now, 45, schedule, [interval('08:45', '09:30')], 30);
    expect(slots).toContainEqual(interval('08:00', '08:45'));
    expect(slots).toContainEqual(interval('09:30', '10:15'));
    expect(slots).not.toContainEqual(interval('08:30', '09:15'));
    expect(slots.some(s => s.start.includes('11:00'))).toBe(false);
    expect(slots[0].start).toBe('2026-11-06T08:00:00.000Z');
});
it('exceptions replace weekly hours including day off', () => {
    expect(slotsFor(input, now, 45, { ...schedule, exceptions: { '2026-11-06': [] } }, [], 30)).toEqual([]);
    expect(slotsFor(input, now, 45, { ...schedule, exceptions: { '2026-11-06': [{ startMinute: 900, endMinute: 1140 }] } }, [], 30)[0].start).toBe('2026-11-06T13:30:00.000Z');
});
it('exact two hours included and horizon local day 30 included but day31 excluded', () => {
    const full = { timezone: 'Europe/Moscow' as const, weekly: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map(d => [d, [{ startMinute: 0, endMinute: 1440 }]])), exceptions: {} };
    const slots = slotsFor({ ...input, to: '2026-12-08T00:00:00.000Z' }, now, 45, full, [], 30);
    expect(slots[0].start).toBe('2026-11-06T08:00:00.000Z');
    expect(slots.at(-1)?.start).toBe('2026-12-06T20:00:00.000Z');
});
it('deadline equal to visit start hides slot and staff never sees past', () => {
    const future = { ...schedule, weekly: { 5: [{ startMinute: 900, endMinute: 1200 }] } };
    expect(slotsFor(input, now, 45, future, [], 30)[0].start).toBe('2026-11-06T13:30:00.000Z');
    expect(slotsFor({ ...input, actorMode: 'staff' }, now, 45, schedule, [], 30).every(s => s.start >= now)).toBe(true);
});
it('validates dates intervals and ordering', () => {
    expect(() => validateSchedule({ ...schedule, exceptions: { '2026-02-30': [] } })).toThrow();
    expect(() => validateSchedule({ ...schedule, weekly: { 1: [{ startMinute: 600, endMinute: 700 }, { startMinute: 650, endMinute: 800 }] } })).toThrow();
});
it('staff preview permits less than one hour without approval delay', () => {
    const full = { timezone: 'Europe/Moscow' as const, weekly: { 5: [{ startMinute: 0, endMinute: 1440 }] }, exceptions: {} };
    expect(slotsFor(input, now, 45, full, [], 30).some(s => s.start === '2026-11-06T06:30:00.000Z')).toBe(false);
    expect(slotsFor({ ...input, actorMode: 'staff' }, now, 45, full, [], 30)).toContainEqual(interval('06:30', '07:15'));
});
it('far future staff preview iterates only requested days', () => {
    const full = { timezone: 'Europe/Moscow' as const, weekly: Object.fromEntries([1,2,3,4,5,6,7].map(d => [d,[{startMinute:0,endMinute:1440}]])), exceptions: {} };
    const calendar = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
        const slots = slotsFor({ from:'2100-01-01T00:00:00.000Z',to:'2100-01-01T20:00:00.000Z',actorMode:'staff' },now,45,full,[],30);
        expect(slots.length).toBeGreaterThan(0);
        expect(calendar.mock.calls.length).toBeLessThan(20);
        expect(slots.every(slot=>slot.start>='2100-01-01T00:00:00.000Z'&&slot.start<='2100-01-01T20:00:00.000Z')).toBe(true);
    } finally { calendar.mockRestore(); }
});
it('entirely past staff preview returns without generating work days', () => {
    const calendar = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
        expect(slotsFor({ from:'2026-11-05T00:00:00.000Z',to:'2026-11-05T20:00:00.000Z',actorMode:'staff' },now,45,schedule,[],30)).toEqual([]);
        expect(calendar.mock.calls.length).toBeLessThan(2);
    } finally { calendar.mockRestore(); }
});
