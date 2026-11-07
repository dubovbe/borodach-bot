import { expect, it } from 'vitest';
import { planReminders } from '../../src/notifications/planner';
const base={visitId:'v1',version:1,start:'2026-11-07T18:00:00.000Z',confirmedAt:'2026-11-06T12:00:00.000Z',now:'2026-11-06T12:00:00.000Z',hours:2 as const};
it('plans day and chosen near reminders with stable versioned class keys',()=>{
  expect(planReminders(base)).toEqual([{key:'reminder:v1:1:day',kind:'day',dueAt:'2026-11-06T18:00:00.000Z'},{key:'reminder:v1:1:near',kind:'near',dueAt:'2026-11-07T16:00:00.000Z'}]);
  expect(planReminders({...base,hours:5})[1].key).toBe('reminder:v1:1:near');
  expect(planReminders({...base,version:2})[0].key).toBe('reminder:v1:2:day');
});
it('uses one-hour fallback when five hours already passed and skips late day',()=>{
  expect(planReminders({visitId:'v1',version:1,hours:5,start:'2026-11-07T18:00:00.000Z',confirmedAt:'2026-11-07T15:00:00.000Z',now:'2026-11-07T15:00:00.000Z'}).map(({kind,dueAt})=>({kind,dueAt}))).toEqual([{kind:'near',dueAt:'2026-11-07T17:00:00.000Z'}]);
});
it.each(['2026-11-07T17:00:00.000Z','2026-11-07T17:01:00.000Z','2026-11-07T18:00:00.000Z'])('confirmation at %s produces no reminder',now=>expect(planReminders({...base,confirmedAt:now,now})).toEqual([]));
it('exact day skips day; exact chosen moment falls back only into future',()=>{
  expect(planReminders({...base,confirmedAt:'2026-11-06T18:00:00.000Z',now:'2026-11-06T18:00:00.000Z'}).map(p=>p.kind)).toEqual(['near']);
  expect(planReminders({...base,now:'2026-11-07T16:00:00.000Z'}).map(p=>p.dueAt)).toEqual(['2026-11-07T17:00:00.000Z']);
});
it.each([1,2,3,4,5] as const)('selected %i hours remains the chosen future time',hours=>expect(planReminders({...base,hours,confirmedAt:'2026-11-07T12:00:00.000Z',now:'2026-11-07T12:00:00.000Z'}).map(p=>p.dueAt)).toEqual([`2026-11-07T${String(18-hours).padStart(2,'0')}:00:00.000Z`]));
it.each([0,6,1.5,NaN])('rejects invalid hours %s',hours=>expect(()=>planReminders({...base,hours:hours as 2})).toThrow());
