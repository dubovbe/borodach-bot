import { expect, it } from 'vitest';
import * as screens from '../../src/bot/screens';
import { slotsFor, localDate } from '../../src/schedule/service';

it('calendar handles leap centuries, month/year navigation and Monday padding', () => {
  const calendar = (screens as any).calendarMonth;
  expect(typeof calendar).toBe('function');
  for (const [month, days] of [['2000-02',29],['2028-02',29],['2100-02',28]] as const) {
    const result = calendar(month, new Set([`${month}-01`]));
    expect(result.days.filter((d:any)=>d.date)).toHaveLength(days);
    expect(result.days.filter((d:any)=>d.enabled).map((d:any)=>d.date)).toEqual([`${month}-01`]);
  }
  expect(calendar('2026-12',new Set()).next).toBe('2027-01');
  expect(calendar('2027-01',new Set()).previous).toBe('2026-12');
  expect(calendar('2026-11',new Set()).days.slice(0,6).every((d:any)=>d.date===null)).toBe(true);
  expect(calendar('2026-11',new Set()).days[6].date).toBe('2026-11-01');
});
it('Moscow day, inclusive 30-day horizon and unrounded duration use explicit clock', () => {
  const now='2026-11-05T21:15:00.000Z';
  expect(localDate(now)).toBe('2026-11-06');
  const schedule={timezone:'Europe/Moscow' as const,weekly:Object.fromEntries([1,2,3,4,5,6,7].map(d=>[d,[{startMinute:0,endMinute:1440}]])),exceptions:{}};
  const slots=slotsFor({from:now,to:'2026-12-07T20:59:59.000Z',actorMode:'client'},now,47,schedule,[],30);
  expect(slots[0].start).toBe('2026-11-05T23:30:00.000Z');
  expect(Date.parse(slots[0].end)-Date.parse(slots[0].start)).toBe(47*60000);
  expect(localDate(slots.at(-1)!.start)).toBe('2026-12-06');
});
it('delivery accepts only opaque generated inline IDs, never arbitrary URL/actions', () => {
  const keyboard={inline_keyboard:[[{text:'Выбрать',callback_data:crypto.randomUUID()}]]};
  expect(()=>screens.safeReplyMarkup(keyboard)).not.toThrow();
  for (const callback_data of ['ю'.repeat(33),'requestBooking:other-user','x'.repeat(65)]) {
    expect(()=>screens.safeReplyMarkup({inline_keyboard:[[{text:'bad',callback_data}]]})).toThrow();
  }
  expect(()=>screens.safeReplyMarkup({inline_keyboard:[[{text:'bad',url:'https://bad.invalid'}]]})).toThrow();
});
