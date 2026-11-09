import { expect,it,vi } from 'vitest';
import * as availability from '../../src/schedule/service';
const now='2026-11-06T04:00:00.000Z';
const full={timezone:'Europe/Moscow' as const,weekly:Object.fromEntries([1,2,3,4,5,6,7].map(d=>[d,[{startMinute:0,endMinute:1440}]])),exceptions:{}};
it('available dates stop at first qualifying start and preserve final local month day',()=>{
 const days=(availability as any).availableDaysFor;
 expect(typeof days).toBe('function');
 const format=vi.spyOn(Intl.DateTimeFormat.prototype,'formatToParts');
 try {
  const result=days({from:'2100-01-01T00:00:00+03:00',to:'2100-01-31T23:59:59.999+03:00',actorMode:'staff'},now,75,full,[],30);
  expect(result).toHaveLength(31);expect(result.at(-1)).toBe('2100-01-31');
  expect(format.mock.calls.length).toBeLessThan(180);
 }finally{format.mockRestore();}
});
it('available dates equal slot dates through deadline, horizon, split work and dense holds',()=>{
 const days=(availability as any).availableDaysFor;expect(typeof days).toBe('function');
 const input={from:now,to:'2026-12-07T20:59:59.999Z',actorMode:'client' as const};
 const schedule={...full,exceptions:{'2026-11-08':[],'2026-11-09':[{startMinute:540,endMinute:600},{startMinute:630,endMinute:900}]}};
 const busy=[{start:'2026-11-07T00:00:00Z',end:'2026-11-07T21:00:00Z'}];
 expect(days(input,now,75,schedule,busy,30)).toEqual([...new Set(availability.slotsFor(input,now,75,schedule,busy,30).map(s=>availability.localDate(s.start)))]);
});
it('one-day start output is at most 48 and approval scans stop at the first relevant interval',()=>{
 expect(availability.slotsFor({from:'2100-01-01T00:00:00+03:00',to:'2100-01-01T23:59:59.999+03:00',actorMode:'staff'},now,1,full,[],30)).toHaveLength(48);
 const spy=vi.spyOn(Intl.DateTimeFormat.prototype,'formatToParts');try{
 expect(availability.firstApprovalWork(full,now,'2100-01-01T00:00:00Z')).toHaveLength(1);expect(spy.mock.calls.length).toBeLessThan(5);
 }finally{spy.mockRestore();}
});
