import {expect,it,vi} from 'vitest';
import {prepareTransferAvailability} from '../../src/booking/transfers';
import type {Tx} from '../../src/db/client';
function context(side:'client'|'staff',oldStart='2200-01-01T07:00:00.000Z'){
 let queries=0;const userId=side==='client'?'client':'staff';
 const query=async(text:string)=>{queries++;
  if(text.startsWith('SELECT v.*,cl.user_id'))return [{id:'visit',client_id:'c',client_user_id:'client',barber_id:'b',barber_user_id:'staff',barber_active:true,barber:'Synthetic',status:'confirmed',version:2,schedule_generation:1,start_at:oldStart,end_at:new Date(Date.parse(oldStart)+75*60000).toISOString(),items:[{serviceId:'s',name:'Frozen',durationMinutes:75,priceKopecks:123}],actor_roles:[side==='client'?'client':'barber'],author_roles:[]}];
  if(text.startsWith('SELECT weekday'))return [1,2,3,4,5,6,7].map(weekday=>({weekday,start_minute:0,end_minute:1440}));
  if(text.startsWith('SELECT local_date'))return [];
  if(text.startsWith('SELECT booking_horizon'))return [{booking_horizon_days:30}];
  if(text.startsWith('SELECT start_at,end_at FROM holds'))return [];
  throw Error('Unexpected query');
 };
 return {c:{tx:{now:'2026-11-06T04:00:00.000Z',query:query as Tx['query']},userId,updateId:'test'},queries:()=>queries};
}
it('staff transfer calendar scans only requested month, not decades to old start, with prepared SQL once',async()=>{
 const f=context('staff'),prepared=await prepareTransferAvailability(f.c,'visit',2,'staff'),count=f.queries();const formatter=vi.spyOn(Intl.DateTimeFormat.prototype,'formatToParts');
 try{expect(prepared.availableDays('2100-01-01T00:00:00+03:00','2100-01-31T23:59:59.999+03:00')).toHaveLength(31);expect(formatter.mock.calls.length).toBeLessThan(180);expect(prepared.slots('2100-01-31T00:00:00+03:00','2100-01-31T23:59:59.999+03:00').length).toBeLessThanOrEqual(48);expect(f.queries()).toBe(count);expect(count).toBe(5);}finally{formatter.mockRestore();}
});
it('client transfer uses current candidate window for approval and retains own-overlap start choices',async()=>{
 const f=context('client','2026-11-06T07:00:00.000Z'),prepared=await prepareTransferAvailability(f.c,'visit',2,'client');
 const slots=prepared.slots('2026-11-06T00:00:00+03:00','2026-11-06T23:59:59.999+03:00');expect(slots.some(s=>s.start==='2026-11-06T07:30:00.000Z')).toBe(true);expect(slots.some(s=>s.start==='2026-11-06T07:00:00.000Z')).toBe(false);expect(slots[0].deadline).toBe('2026-11-06T05:00:00.000Z');
 expect(prepared.availableDays('2026-11-06T00:00:00+03:00','2026-11-06T23:59:59.999+03:00')).toEqual(['2026-11-06']);
 const distant=context('client'),future=await prepareTransferAvailability(distant.c,'visit',2,'client'),formatter=vi.spyOn(Intl.DateTimeFormat.prototype,'formatToParts');
 try{expect(future.availableDays('2026-11-06T00:00:00+03:00','2026-11-06T23:59:59.999+03:00')).toEqual(['2026-11-06']);expect(formatter.mock.calls.length).toBeLessThan(20);}finally{formatter.mockRestore();}
});
