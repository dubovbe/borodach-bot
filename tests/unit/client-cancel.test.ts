import {expect,it} from 'vitest';
import {executeBooking} from '../../src/booking/service';
import type {Tx} from '../../src/db/client';
const now='2026-11-07T18:00:00.000Z';
function context(owner='u',start=now,status='confirmed'){
 const writes:string[]=[];
 const tx:Tx={now,query:async<T>(sql:string)=>{
  if(sql.startsWith('SELECT role'))return [{role:'admin'},{role:'client'}] as T[];
  if(sql.startsWith('SELECT v.*'))return [{id:'v',client_user_id:owner,barber_user_id:'u',barber_active:true,status,version:1,start_at:start,deadline:'2026-11-08T01:00:00Z'}] as T[];
  if(sql.startsWith('SELECT min'))return [{due:null}] as T[];
  if(sql.startsWith('WITH entity'))return [{version:2}] as T[];
  writes.push(sql);return [];
 }};
 return {tx,userId:'u',updateId:'1',writes};
}
it('client purpose never falls back to admin after visit start',async()=>{const c=context();await expect(executeBooking(c,{kind:'cancelBooking',visitId:'v',expectedVersion:1,purpose:'client',reason:'admin'} as any)).rejects.toMatchObject({code:'already_started'});expect(c.writes).toEqual([]);});
it('client purpose never uses admin to cancel foreign visit',async()=>{const c=context('other','2026-11-08T18:00:00Z');await expect(executeBooking(c,{kind:'cancelBooking',visitId:'v',expectedVersion:1,purpose:'client'} as any)).rejects.toMatchObject({code:'forbidden'});expect(c.writes).toEqual([]);});
it('withdraw is an owner-only pending transition',async()=>{const c=context('u','2026-11-08T18:00:00Z','pending');expect((await executeBooking(c,{kind:'withdrawBooking',visitId:'v',expectedVersion:1} as any)).status).toBe('cancelled');expect(c.writes.some(s=>s.startsWith('DELETE FROM holds'))).toBe(true);});
