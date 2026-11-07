import {expect,it} from 'vitest';
import {Repository} from '../../src/db/repository';
import {Outbox} from '../../src/notifications/outbox';
import {DeliveryError,type Delivery} from '../../src/notifications/transport';
import {cancelLinkedTransfers,recordTransferEvent} from '../../src/booking/transfers';
import {clientDatabase,fixtureBarber,fixtureService} from './client-db';
import type {Command} from '../../src/domain/types';

function fixture(manual=false){
 const f=clientDatabase(),client=f.user('100');f.user('200');f.user('201').roles=['admin'];
 const v={id:crypto.randomUUID(),client_id:manual?crypto.randomUUID():client.client,barber_id:fixtureBarber,barber_user_id:f.user('200').id,status:'confirmed',start_at:'2026-11-07T07:00:00.000Z',end_at:'2026-11-07T07:45:00.000Z',version:1,schedule_generation:1,items:[{serviceId:fixtureService,name:'Frozen haircut',priceKopecks:123400,durationMinutes:45}]};f.visits.set(v.id,v);
 let clock=f.now,update=97000;const transaction=f.database.transaction;f.database.transaction=run=>transaction(tx=>run({...tx,now:clock}));
 const repo=new Repository(f.database),execute=(actor:string,c:Command)=>repo.execute({telegramId:actor},c,String(update++));
 const propose=async(actor='200',newStart='2026-11-07T08:00:00.000Z')=>{const r=await execute(actor,{kind:actor==='100'?'requestTransfer':'proposeTransfer',visitId:v.id,expectedVersion:v.version,newStart,reason:'Changed schedule'});expect(r.status).toBe('pending');return r.entityId!;};
 const accept=async(id:string)=>{expect((await execute('100',{kind:'decideTransfer',transferId:id,expectedVersion:1,accept:true})).status).toBe('accepted');};
 const row=(id:string,event:string,chatId:string)=>{const r=f.outbox.find(o=>o.entity_id===id&&o.payload.event===event&&o.chat_id===chatId);expect(r,'a real queued target row must exist').toBeTruthy();expect(r.status).toBe('pending');expect(Date.parse(r.due_at)).toBeLessThanOrEqual(Date.parse(clock));return r;};
 const only=(target:any)=>{for(const o of f.outbox)if(o!==target&&o.status==='pending')o.status='cancelled';};
 const deliver=(send:(d:Delivery)=>Promise<{messageId:string}>)=>new Outbox(f.database,{send}).deliver(clock,1);
 return {...f,v,execute,propose,accept,row,only,deliver,setClock:(t:string)=>{expect(Date.parse(t)).toBeGreaterThanOrEqual(Date.parse(clock));clock=t;}};
}

it.each(['staff-role','staff-assignment','client-role','phone-author'] as const)('pending retry suppresses acceptance after %s loss while recipient stays authorized',async mode=>{
 const f=fixture(mode==='phone-author'),author=mode==='client-role'?'100':'200',recipient=mode==='client-role'?'200':mode==='phone-author'?'201':'100';
 const id=await f.propose(author),target=f.row(id,'transfer_pending',recipient);f.only(target);
 const buttons=target.payload.buttons.map((id:string)=>f.transferCallbacks.get(id));expect(buttons.some((b:any)=>b.action===(mode==='phone-author'?'phone':'accept'))).toBe(true);
 let attempts=0;await f.deliver(async()=>{attempts++;throw new DeliveryError('transient');});expect(attempts).toBe(1);expect(target.status).toBe('pending');expect(target.attempts).toBe(1);
 if(mode==='staff-assignment')f.v.barber_user_id=f.user('201').id;else f.user(author).roles=[];
 f.setClock('2026-11-06T04:00:03.000Z');
 await f.deliver(async()=>{attempts++;return {messageId:'must-not-send'};});
 expect(target.attempts).toBe(2);expect(target.status).toBe('cancelled');expect(attempts).toBe(1);
 if(mode!=='phone-author'){
  const decline=buttons.find((b:any)=>b.action==='decline');expect(decline).toBeTruthy();
  expect((await f.execute(recipient,{kind:'clientAction',callbackId:decline.id})).status).toBe('declined');expect(f.v.start_at).toBe('2026-11-07T07:00:00.000Z');
 }
});

it.each([['move','pending'],['move','leased'],['cancel','pending'],['cancel','leased']] as const)('accepted %s outcome suppresses an older %s result retry',async(outcome,retry)=>{
 const f=fixture(),t1=await f.propose();await f.accept(t1);const first=f.row(t1,'transfer_accepted','100');f.only(first);
 const sent:Delivery[]=[];let attempts=0;await f.deliver(async()=>{attempts++;throw new DeliveryError('transient');});expect(first.attempts).toBe(1);
 f.setClock('2026-11-06T04:00:01.000Z');
 if(outcome==='move'){
  const t2=await f.propose('200','2026-11-07T09:00:00.000Z');await f.accept(t2);const second=f.row(t2,'transfer_accepted','100');
  for(const o of f.outbox)if(o!==first&&o!==second&&o.status==='pending')o.status='cancelled';
  await f.deliver(async d=>{sent.push(d);return {messageId:'current-result'};});expect(second.status).toBe('sent');expect(sent[0]?.entityId).toBe(t2);
 }else expect((await f.execute('100',{kind:'cancelBooking',visitId:f.v.id,expectedVersion:f.v.version,purpose:'client'})).status).toBe('cancelled');
 if(retry==='leased')Object.assign(first,{status:'leased',claim_token:crypto.randomUUID(),lease_until:'2026-11-06T04:00:02.000Z'});
 f.setClock('2026-11-06T04:00:03.000Z');
 await f.deliver(async d=>{attempts++;sent.push(d);return {messageId:'stale-result'};});
 expect(first.attempts).toBe(2);expect(first.status).toBe('cancelled');expect(attempts).toBe(1);expect(sent.every(d=>d.entityId!==t1)).toBe(true);
});

it.each(['declined','expired'] as const)('%s retained-time result is current only in its old scheduling generation',async status=>{
 const f=fixture(),id=await f.propose();
 if(status==='declined')expect((await f.execute('100',{kind:'decideTransfer',transferId:id,expectedVersion:1,accept:false})).status).toBe('declined');
 else {Object.assign(f.transfers.get(id),{status:'expired',version:2});await f.database.transaction(tx=>recordTransferEvent({tx,userId:null,updateId:null},'transfer_expired',id,f.v.id));}
 const target=f.row(id,`transfer_${status}`,'100');f.only(target);let sends=0;
 await f.deliver(async()=>{sends++;throw new DeliveryError('transient');});expect(sends).toBe(1);
 f.v.schedule_generation++;f.v.start_at='2026-11-07T09:00:00.000Z';f.v.end_at='2026-11-07T09:45:00.000Z';f.v.version++;
 f.setClock('2026-11-06T04:00:03.000Z');await f.deliver(async()=>{sends++;return {messageId:'stale'};});expect(target.attempts).toBe(2);expect(target.status).toBe('cancelled');expect(sends).toBe(1);
});

it('accepted result remains deliverable across an ownership-only version bump',async()=>{
 const f=fixture(),id=await f.propose();await f.accept(id);const target=f.row(id,'transfer_accepted','200');f.only(target);f.v.version++;
 const sent:Delivery[]=[];await f.deliver(async d=>{sent.push(d);return {messageId:'current'};});expect(sent).toHaveLength(1);expect(target.status).toBe('sent');expect(f.v.schedule_generation).toBe(2);
});
it.each(['confirmed','cancelled'] as const)('phone/link cancellation notice remains current for a %s old interval',async state=>{
 const f=fixture(true),id=await f.propose();f.v.client_id=f.user('100').client;f.v.version++;f.v.status=state;
 await f.database.transaction(tx=>cancelLinkedTransfers(tx,[f.v.id]));const target=f.row(id,'transfer_cancelled','200');f.only(target);
 const sent:Delivery[]=[];await f.deliver(async d=>{sent.push(d);return {messageId:'linked'};});expect(sent).toHaveLength(1);expect(target.status).toBe('sent');expect((sent[0].payload as {text:string}).text).toContain('Требуется новое предложение');
});
