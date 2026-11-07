import {expect,it} from 'vitest';
import {reconcileReminders,setReminderHours} from '../../src/notifications/reminders';
import type {Tx} from '../../src/db/client';
const start='2026-11-07T18:00:00.000Z',now='2026-11-06T12:00:00.000Z';
function fixture(reminders:any[],hours=2){
 const calls:Array<{sql:string;v:unknown[]}>=[];
 const tx:Tx={now,query:async<T>(sql:string,v:unknown[])=>{calls.push({sql,v});if(sql.startsWith('SELECT v.id'))return [{id:'v',version:2,start_at:start,chat_id:'100',reminder_hours:hours,confirmed_at:null,reminders}] as T[];if(sql.startsWith('SELECT reminder_hours'))return [{reminder_hours:hours}] as T[];return [];}};
 return {tx,userId:'u',updateId:'1',calls};
}
const row=(kind:string,extra={})=>({id:kind,logical_key:`reminder:v:2:${kind}`,entity_version:2,status:'leased',sent_at:null,due_at:kind==='day'?'2026-11-06T18:00:00.000Z':'2026-11-07T16:00:00.000Z',payload:{reminderKind:kind,scheduledStart:start,scheduledDueAt:kind==='day'?'2026-11-06T18:00:00.000Z':'2026-11-07T16:00:00.000Z'},...extra});
it('ordinary ensure and unchanged preference perform only reads, preserving overdue retry/lease',async()=>{
 const c=fixture([row('day',{due_at:'2026-11-06T11:00:00.000Z'}),row('near')]);await reconcileReminders(c);expect(c.calls).toHaveLength(1);
 c.calls.length=0;await setReminderHours(c,2);expect(c.calls).toHaveLength(2);expect(c.calls.every(x=>x.sql.startsWith('SELECT'))).toBe(true);
});
it('sent history across version and non-null sent_at terminal suppress both classes without mutations',async()=>{
 const c=fixture([row('day',{entity_version:1,logical_key:'old:day',status:'sent'}),row('near',{entity_version:1,logical_key:'old:near',status:'cancelled',sent_at:now})]);
 await reconcileReminders(c,{mode:'preference'});expect(c.calls).toHaveLength(1);
});
it.each([0,6,1.1,NaN])('invalid preference %s is rejected before SQL',async hours=>{const c=fixture([]);await expect(setReminderHours(c,hours)).rejects.toMatchObject({code:'invalid_reminder_hours'});expect(c.calls).toEqual([]);});
it('a genuine return to the same start schedules fresh future classes in a new generation',async()=>{
 const c=fixture([row('day',{entity_version:1,logical_key:'old:day',status:'sent'}),row('near',{entity_version:1,logical_key:'old:near',status:'sent'})]);
 const query=c.tx.query;
 c.tx.query=async<T>(sql:string,v:unknown[])=>{const result=await query<T>(sql,v);return sql.startsWith('SELECT v.id')?result.map(x=>({...x,schedule_generation:3})):result;};
 await reconcileReminders(c);
 const write=c.calls.find(x=>x.sql.startsWith('WITH cancelled'));
 expect(write).toBeDefined();
 const desired=JSON.parse(write!.v[1] as string);expect(desired).toHaveLength(2);
 expect(desired.every((p:any)=>p.payload.scheduleGeneration===3)).toBe(true);
});
