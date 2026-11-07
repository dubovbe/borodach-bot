import pg from 'pg';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { testDatabaseUrl } from './safety';
import { migrate } from '../../scripts/migrate';
import { seed } from '../../scripts/seed';
import { Repository } from '../../src/db/repository';
import { nodeDatabase } from '../../scripts/node-db';
import type { Command } from '../../src/domain/types';
import type { Database } from '../../src/db/client';
import { redeliverOnceOnLockTimeout } from './redelivery';
import {acceptContact} from '../../src/identity/service';
import {Outbox} from '../../src/notifications/outbox';
import {DeliveryError,type Delivery} from '../../src/notifications/transport';
const url = testDatabaseUrl();
const schema = `stage8_${crypto.randomUUID().replaceAll('-', '')}`;
const scoped = new URL(url);
scoped.searchParams.set('options', `-c search_path=${schema}`);
let admin: pg.Client;
let created = false;
const b = '00000000-0000-4000-8000-000000000002', s = '00000000-0000-4000-8000-000000000003';
const b2 = '00000000-0000-4000-8000-000000000004';
const now = '2026-11-06T04:00:00.000Z';
// Boundary fixture overrides ONLY Tx.now; production always reads PostgreSQL after shop lock.
const db = (clock = now): Database => { const base = nodeDatabase(scoped.toString()); return { read: base.read, transaction: run => base.transaction(tx => run({ ...tx, now: clock })) }; };
const repo = (clock = now) => new Repository(db(clock));
const execute = (id: string, command: Command, update: string, clock = now) => repo(clock).execute({ telegramId: id }, command, update);
const request = (barberId = b, start = '2026-11-06T07:00:00.000Z'): Extract<Command,{kind:'requestBooking'}> => ({ kind: 'requestBooking', barberId, serviceIds: [s], start });
const change = (kind: 'confirmBooking' | 'cancelBooking' | 'declineBooking', visitId: string, expectedVersion = 1, reason?: string): Command => ({ kind, visitId, expectedVersion, reason });
beforeAll(async () => { admin = new pg.Client({ connectionString: scoped.toString(), connectionTimeoutMillis: 5000 }); await admin.connect(); await admin.query(`CREATE SCHEMA "${schema}"`); created = true; await migrate(scoped.toString()); await seed(scoped.toString()); });
afterAll(async () => { if (created)
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin?.end(); });
beforeEach(async () => {
    await admin.query('TRUNCATE telegram_users,visits,weekly_hours,date_exceptions,outbox,jobs CASCADE');
    await seed(scoped.toString());
    for (const id of ['100', '101', '200', '201']) {
        const user = (await admin.query('INSERT INTO telegram_users(telegram_id,last_seen_at) VALUES($1,$2) RETURNING id', [id, now])).rows[0].id;
        await admin.query('INSERT INTO roles(user_id,role) VALUES($1,$2)', [user, id === '201' ? 'admin' : id === '200' ? 'barber' : 'client']);
        if (id === '100' || id === '101') {
            const phone = id === '100' ? '+79123456789' : '+79123456780';
            const client = (await admin.query('INSERT INTO clients(user_id,name,phone) VALUES($1,$2,$3) RETURNING id', [user, 'Test',phone])).rows[0].id;
            await admin.query('INSERT INTO phone_claims(client_id,user_id,phone,claimed_at) VALUES($1,$2,$3,$4)',[client,user,phone,now]);
        }
        if (id === '200')
            await admin.query('UPDATE barbers SET user_id=$1 WHERE id=$2', [user, b]);
    }
    await admin.query('INSERT INTO barbers(id,name,rank_id) SELECT $1,$2,rank_id FROM barbers WHERE id=$3 ON CONFLICT(id) DO UPDATE SET version=1', [b2, 'Second', b]);
    await admin.query('UPDATE barbers SET version=1,archived_at=NULL');
    await admin.query('UPDATE services SET archived_at=NULL');
    await admin.query('INSERT INTO assignments(barber_id,service_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [b2, s]);
    await admin.query('UPDATE rank_tariffs SET duration_minutes=90,price_kopecks=150000');
    for (const barber of [b, b2])
        for (let day = 1; day <= 7; day++)
            await admin.query('INSERT INTO weekly_hours(barber_id,weekday,start_minute,end_minute) VALUES($1,$2,0,1200)', [barber, day]);
});

const move=(visitId:string,newStart='2026-11-06T07:30:00.000Z',kind='requestTransfer',expectedVersion=2):Command=>({kind,visitId,newStart,expectedVersion,reason:'Client requested a different time'} as Command);
const decision=(transferId:string,accept=true):Command=>({kind:'decideTransfer',transferId,expectedVersion:1,accept} as Command);
async function confirmed(){const v=(await execute('100',request(),'80')).entityId!;expect((await execute('200',change('confirmBooking',v),'81')).status).toBe('confirmed');return v;}
it('retains old confirmed interval and reminders while holding overlapping frozen transfer time',async()=>{
 const v=await confirmed();
 const before=(await admin.query('SELECT * FROM visit_items WHERE visit_id=$1',[v])).rows;
 const remindersBefore=(await admin.query("SELECT * FROM outbox WHERE entity_id=$1 AND kind='reminder'",[v])).rows;
 expect(remindersBefore).toHaveLength(1);expect(remindersBefore[0].due_at.toISOString()).toBe('2026-11-06T05:00:00.000Z');
 await admin.query('DELETE FROM assignments WHERE barber_id=$1',[b]);
 await admin.query('UPDATE services SET archived_at=$1 WHERE id=$2',[now,s]);
 const t=await execute('100',move(v),'82');expect(t.status).toBe('pending');
 expect((await admin.query("SELECT * FROM outbox WHERE entity_id=$1 AND kind='reminder'",[v])).rows).toEqual(remindersBefore);
 expect((await admin.query('SELECT status,version,start_at FROM visits WHERE id=$1',[v])).rows[0]).toMatchObject({status:'confirmed',version:2,start_at:new Date('2026-11-06T07:00:00Z')});
 expect((await admin.query('SELECT kind FROM holds WHERE visit_id=$1 ORDER BY kind',[v])).rows).toEqual([{kind:'transfer'},{kind:'visit'}]);
 expect((await admin.query('SELECT start_at,end_at,expires_at FROM holds WHERE transfer_id=$1',[t.entityId])).rows).toEqual([{start_at:new Date('2026-11-06T07:30:00Z'),end_at:new Date('2026-11-06T09:00:00Z'),expires_at:new Date('2026-11-06T05:00:00Z')}]);
 expect((await admin.query("SELECT kind,status,entity_version,due_at,payload FROM jobs WHERE payload->>'transferId'=$1",[t.entityId])).rows).toEqual([{kind:'expire_transfer',status:'pending',entity_version:1,due_at:new Date('2026-11-06T05:00:00Z'),payload:{transferId:t.entityId}}]);
 expect((await execute('101',request(b,'2026-11-06T08:30:00.000Z'),'83')).status).toBe('offer_unavailable');
 expect((await execute('200',decision(t.entityId!),'84')).status).toBe('accepted');
 expect((await admin.query('SELECT status,version,schedule_generation,start_at,end_at FROM visits WHERE id=$1',[v])).rows[0]).toMatchObject({status:'confirmed',version:3,schedule_generation:2,start_at:new Date('2026-11-06T07:30:00Z'),end_at:new Date('2026-11-06T09:00:00Z')});
 expect((await admin.query('SELECT * FROM visit_items WHERE visit_id=$1',[v])).rows).toEqual(before);
 expect((await admin.query('SELECT kind FROM holds WHERE visit_id=$1',[v])).rows).toEqual([{kind:'visit'}]);
 const remindersAfter=(await admin.query("SELECT * FROM outbox WHERE entity_id=$1 AND kind='reminder' ORDER BY entity_version",[v])).rows;
 expect(remindersAfter).toHaveLength(2);expect(remindersAfter[0].status).toBe('cancelled');
 expect(remindersAfter[1]).toMatchObject({status:'pending',entity_version:3,payload:{scheduleGeneration:2,reminderKind:'near',scheduledStart:'2026-11-06T07:30:00.000Z'}});
 expect(remindersAfter[1].due_at.toISOString()).toBe('2026-11-06T05:30:00.000Z');
});
it('rejects author self-consent and expires strictly at deadline without losing old visit',async()=>{
 const v=await confirmed(); const t=await execute('100',move(v),'82');expect(t.status).toBe('pending');
 await admin.query("INSERT INTO roles(user_id,role) SELECT id,'admin' FROM telegram_users WHERE telegram_id=100");
 expect((await execute('100',decision(t.entityId!),'83')).status).toBe('forbidden');
 expect((await execute('200',decision(t.entityId!),'84','2026-11-06T05:00:00.000Z')).status).toBe('invalid_state');
 expect((await admin.query('SELECT status,version FROM visits WHERE id=$1',[v])).rows[0]).toEqual({status:'confirmed',version:2});
 expect((await admin.query('SELECT kind FROM holds WHERE visit_id=$1',[v])).rows).toEqual([{kind:'visit'}]);
});
it('one pending client transfer counts toward new booking and accept versus cancel is atomic',async()=>{
 const v=await confirmed();const t=await execute('100',move(v),'82');expect(t.status).toBe('pending');
 expect((await execute('100',request(b2,'2026-11-06T10:00:00.000Z'),'83')).status).toBe('pending_limit');
 const results=await Promise.all([redeliverOnceOnLockTimeout(()=>execute('200',decision(t.entityId!),'84')),redeliverOnceOnLockTimeout(()=>execute('100',change('cancelBooking',v,2),'85'))]);
 expect(results.map(r=>r.status).sort()).toEqual(expect.arrayContaining(results.some(r=>r.status==='accepted')?['accepted','stale_version']:['cancelled','invalid_state']));
 expect((await admin.query("SELECT * FROM transfers WHERE visit_id=$1 AND status='pending'",[v])).rows).toHaveLength(0);
 expect((await admin.query('SELECT * FROM holds WHERE visit_id=$1',[v])).rows).toHaveLength(results.some(r=>r.status==='accepted')?1:0);
});
it('staff can offer closer time but requires reason and current opposite owner consent',async()=>{
 const v=await confirmed();
 expect((await execute('200',{...move(v,'2026-11-06T04:30:00.000Z','proposeTransfer'),reason:''} as Command,'82')).status).toBe('reason_required');
 const t=await execute('200',move(v,'2026-11-06T04:30:00.000Z','proposeTransfer'),'83');expect(t.status).toBe('pending');
 expect((await execute('200',decision(t.entityId!),'84')).status).toBe('forbidden');
 expect((await execute('101',decision(t.entityId!),'85')).status).toBe('forbidden');
 expect((await execute('200',{kind:'recordPhoneAgreement',transferId:t.entityId!,expectedVersion:1} as Command,'86')).status).toBe('forbidden');
 expect((await execute('100',decision(t.entityId!),'87')).status).toBe('accepted');
});
it('role loss after proposal blocks acceptance and allows safe decline',async()=>{
 const v=await confirmed(),t=await execute('200',move(v,'2026-11-06T10:00:00.000Z','proposeTransfer'),'82');expect(t.status).toBe('pending');
 await admin.query("DELETE FROM roles WHERE role='barber'");
 expect((await execute('100',decision(t.entityId!),'83')).status).toBe('forbidden');
 expect((await execute('100',decision(t.entityId!,false),'84')).status).toBe('declined');
 expect((await admin.query('SELECT kind FROM holds WHERE visit_id=$1',[v])).rows).toEqual([{kind:'visit'}]);
});
it('consent buttons remain independent of ordinary client start and expire at transfer deadline',async()=>{
 const v=await confirmed(),t=await execute('200',move(v,'2026-11-06T10:00:00.000Z','proposeTransfer'),'82');expect(t.status).toBe('pending');
 const cb=(await admin.query("SELECT * FROM transfer_callbacks WHERE transfer_id=$1 AND action='accept'",[t.entityId])).rows[0];
 expect(cb.expires_at.toISOString()).toBe('2026-11-06T05:00:00.000Z');
 await execute('100',{kind:'start',payload:null},'83');
 expect((await execute('101',{kind:'clientAction',callbackId:cb.id},'84')).status).toBe('forbidden');
 expect((await execute('100',{kind:'clientAction',callbackId:cb.id},'85')).status).toBe('accepted');
 expect((await execute('100',{kind:'clientAction',callbackId:cb.id},'86')).status).toBe('stale_callback');
});
it('phone agreement records real staff and first contact cancels only pending new hold atomically',async()=>{
 const v=await confirmed();
 const manual=(await admin.query("INSERT INTO clients(name,phone) VALUES('Manual fixture','+79123456781') RETURNING id")).rows[0].id;
 await admin.query('UPDATE visits SET client_id=$2 WHERE id=$1',[v,manual]);
 let t=await execute('200',move(v,'2026-11-06T10:00:00.000Z','proposeTransfer'),'82');expect(t.status).toBe('pending');
 expect((await execute('200',{kind:'recordPhoneAgreement',transferId:t.entityId!,expectedVersion:1} as Command,'83')).status).toBe('accepted');
 expect((await admin.query('SELECT agreement_channel,agreed_at,agreed_by=(SELECT id FROM telegram_users WHERE telegram_id=200) AS real_actor FROM transfers WHERE id=$1',[t.entityId])).rows[0]).toEqual({agreement_channel:'phone',agreed_at:new Date(now),real_actor:true});
 t=await execute('200',move(v,'2026-11-06T12:00:00.000Z','proposeTransfer',3),'84');expect(t.status).toBe('pending');
 // A new claimant has no prior phone claims; the direct protected identity operation is exercised.
 await execute('300',{kind:'start',payload:null},'85');
 expect(await db().transaction(tx=>acceptContact({telegramId:'300'},{userId:'300',phone:'+79123456781'},tx))).toBeTruthy();
 expect((await admin.query('SELECT status FROM transfers WHERE id=$1',[t.entityId])).rows[0].status).toBe('cancelled');
 expect((await admin.query('SELECT kind,start_at FROM holds WHERE visit_id=$1',[v])).rows).toEqual([{kind:'visit',start_at:new Date('2026-11-06T10:00:00Z')}]);
 expect((await admin.query("SELECT * FROM jobs WHERE payload->>'transferId'=$1 AND status IN ('pending','leased')",[t.entityId])).rows).toHaveLength(0);
 expect((await admin.query('SELECT * FROM transfer_callbacks WHERE transfer_id=$1 AND consumed_at IS NULL',[t.entityId])).rows).toHaveLength(0);
 expect((await admin.query("SELECT * FROM outbox WHERE entity_id=$1 AND payload->>'event'='transfer_pending' AND status IN ('pending','leased')",[t.entityId])).rows).toHaveLength(0);
 expect((await execute('200',{kind:'recordPhoneAgreement',transferId:t.entityId!,expectedVersion:1} as Command,'87')).status).toBe('invalid_state');
});
it('own overlap is allowed but foreign requests cannot occupy the proposed interval',async()=>{
 const v=await confirmed(),t=await execute('100',move(v),'82');expect(t.status).toBe('pending');
 expect((await execute('101',request(b,'2026-11-06T08:30:00.000Z'),'83')).status).toBe('slot_unavailable');
 expect((await execute('101',request(b,'2026-11-06T09:00:00.000Z'),'84')).status).toBe('pending');
 expect((await execute('200',decision(t.entityId!),'85')).status).toBe('accepted');
});
it('client lead, local horizon, identical time and one pending on a visit are enforced',async()=>{
 const v=await confirmed();
 expect((await execute('100',move(v,'2026-11-06T05:30:00.000Z'),'82')).status).toBe('slot_unavailable');
 expect((await execute('100',move(v,'2026-11-06T07:00:00.000Z'),'83')).status).toBe('slot_unavailable');
 expect((await execute('100',move(v,'2026-12-07T07:00:00.000Z'),'84')).status).toBe('slot_unavailable');
 const t=await execute('100',move(v,'2026-11-06T06:00:00.000Z'),'85');expect(t.status).toBe('pending');
 expect((await execute('200',move(v,'2026-11-06T10:00:00.000Z','proposeTransfer'),'86')).status).toBe('pending_transfer');
 expect((await execute('200',decision(t.entityId!,false),'87')).status).toBe('declined');
 expect((await execute('200',move(v,'2026-12-07T07:00:00.000Z','proposeTransfer'),'88')).status).toBe('pending');
});
it('an existing pending booking blocks a client request and foreign client or barber has no rights',async()=>{
 const v=await confirmed();
 expect((await execute('101',move(v),'82')).status).toBe('forbidden');
 await admin.query("INSERT INTO roles(user_id,role) SELECT id,'barber' FROM telegram_users WHERE telegram_id=101");
 expect((await execute('101',move(v,'2026-11-06T10:00:00.000Z','proposeTransfer'),'83')).status).toBe('forbidden');
 expect((await execute('100',request(b2,'2026-11-06T10:00:00.000Z'),'84')).status).toBe('pending');
 expect((await execute('100',move(v),'85')).status).toBe('pending_limit');
});
it('schedule edits must fit both the old and proposed intervals',async()=>{
 const v=await confirmed(),t=await execute('100',move(v,'2026-11-06T10:00:00.000Z'),'82');expect(t.status).toBe('pending');
 for(const [updateId,startMinute,endMinute] of [['83',600,690],['84',780,870]] as const){
  const schedule={timezone:'Europe/Moscow' as const,weekly:{},exceptions:{'2026-11-06':[{startMinute,endMinute}]}};
  expect((await execute('201',{kind:'changeSchedule',barberId:b,expectedVersion:1,schedule},updateId)).status).toBe('schedule_conflict');
 }
 expect((await admin.query('SELECT count(*)::int n FROM holds WHERE visit_id=$1',[v])).rows[0].n).toBe(2);
});
it.each(['accept','decline'] as const)('concurrent %s versus accept produces one decision and one visit hold',async first=>{
 const v=await confirmed(),t=await execute('100',move(v),'82');expect(t.status).toBe('pending');
 const results=await Promise.all([redeliverOnceOnLockTimeout(()=>execute('200',decision(t.entityId!,first==='accept'),'83')),redeliverOnceOnLockTimeout(()=>execute('201',decision(t.entityId!),'84'))]);
 const states=results.map(r=>r.status);expect(states.filter(s=>s==='accepted'||s==='declined')).toHaveLength(1);expect(states).toContain('invalid_state');
 const accepted=states.includes('accepted');expect((await admin.query('SELECT start_at,version,schedule_generation FROM visits WHERE id=$1',[v])).rows[0]).toMatchObject({start_at:new Date(accepted?'2026-11-06T07:30Z':'2026-11-06T07:00Z'),version:accepted?3:2,schedule_generation:accepted?2:1});
 expect((await admin.query('SELECT kind FROM holds WHERE visit_id=$1',[v])).rows).toEqual([{kind:'visit'}]);
 expect((await admin.query("SELECT * FROM jobs WHERE payload->>'transferId'=$1 AND status IN ('pending','leased')",[t.entityId])).rows).toHaveLength(0);
 expect((await admin.query('SELECT * FROM transfer_callbacks WHERE transfer_id=$1 AND consumed_at IS NULL',[t.entityId])).rows).toHaveLength(0);
});
it('A to B to A replans a future fallback after a previously sent class and preserves sent history',async()=>{
 const v=await confirmed();
 await admin.query("UPDATE outbox SET status='sent',sent_at='2026-11-06T05:00Z' WHERE entity_id=$1 AND kind='reminder'",[v]);
 let t=await execute('200',move(v,'2026-11-06T08:00:00.000Z','proposeTransfer'),'82','2026-11-06T05:05:00.000Z');expect(t.status).toBe('pending');
 expect((await execute('100',decision(t.entityId!),'83','2026-11-06T05:10:00.000Z')).status).toBe('accepted');
 t=await execute('200',move(v,'2026-11-06T07:00:00.000Z','proposeTransfer',3),'84','2026-11-06T05:15:00.000Z');expect(t.status).toBe('pending');
 expect((await execute('100',decision(t.entityId!),'85','2026-11-06T05:20:00.000Z')).status).toBe('accepted');
 const history=(await admin.query("SELECT status,due_at,payload,entity_version FROM outbox WHERE entity_id=$1 AND kind='reminder' ORDER BY entity_version",[v])).rows;
 expect(history.map(r=>r.status)).toEqual(['sent','cancelled','pending']);expect(history[2]).toMatchObject({entity_version:4,payload:{scheduleGeneration:3,scheduledStart:'2026-11-06T07:00:00.000Z'}});expect(history[2].due_at.toISOString()).toBe('2026-11-06T06:00:00.000Z');
 await execute('100',{kind:'setReminderHours',hours:2},'86','2026-11-06T05:25:00.000Z');
 expect((await admin.query("SELECT count(*)::int n FROM outbox WHERE entity_id=$1 AND kind='reminder'",[v])).rows[0].n).toBe(3);
});
it('admin owner cannot propose to self; a separate admin initiator receives the decline',async()=>{
 const v=await confirmed();await admin.query("INSERT INTO roles(user_id,role) SELECT id,'admin' FROM telegram_users WHERE telegram_id=100");
 expect((await execute('100',move(v,'2026-11-06T10:00:00.000Z','proposeTransfer'),'82')).status).toBe('forbidden');
 const t=await execute('201',move(v,'2026-11-06T10:00:00.000Z','proposeTransfer'),'83');expect(t.status).toBe('pending');
 expect((await execute('100',decision(t.entityId!,false),'84')).status).toBe('declined');
 expect((await admin.query("SELECT chat_id::text FROM outbox WHERE entity_id=$1 AND payload->>'event'='transfer_declined'",[t.entityId])).rows.map(r=>r.chat_id)).toContain('201');
});
async function deliveryTarget(transferId:string,event:string,chatId:string){
 const rows=(await admin.query("SELECT * FROM outbox WHERE entity_id=$1 AND payload->>'event'=$2 AND chat_id=$3",[transferId,event,chatId])).rows;
 expect(rows).toHaveLength(1);expect(rows[0].status).toBe('pending');return rows[0];
}
async function isolateDelivery(...ids:string[]){await admin.query("UPDATE outbox SET status='cancelled',claim_token=NULL,lease_until=NULL WHERE status IN ('pending','leased') AND NOT(id=ANY($1::uuid[]))",[ids]);}
it.each(['staff','client'] as const)('delivery review pending %s author-loss retry is suppressed but old decline remains safe',async side=>{
 const v=await confirmed(),author=side==='staff'?'200':'100',recipient=side==='staff'?'100':'200';
 const t=await execute(author,move(v,'2026-11-06T10:00:00.000Z',side==='staff'?'proposeTransfer':'requestTransfer'),'82');expect(t.status).toBe('pending');
 const target=await deliveryTarget(t.entityId!,'transfer_pending',recipient);await isolateDelivery(target.id);
 const cb=(await admin.query("SELECT id FROM transfer_callbacks WHERE transfer_id=$1 AND action='decline' AND user_id=(SELECT id FROM telegram_users WHERE telegram_id=$2)",[t.entityId,recipient])).rows[0];expect(cb).toBeTruthy();
 let sends=0;await new Outbox(db(),{send:async()=>{sends++;throw new DeliveryError('transient');}}).deliver(now,1);expect(sends).toBe(1);
 await admin.query('DELETE FROM roles WHERE user_id=(SELECT id FROM telegram_users WHERE telegram_id=$1) AND role=$2',[author,side==='staff'?'barber':'client']);
 const clock='2026-11-06T04:00:03.000Z';await new Outbox(db(clock),{send:async()=>{sends++;return {messageId:'must-not-send'};}}).deliver(clock,1);
 expect((await admin.query('SELECT status,attempts FROM outbox WHERE id=$1',[target.id])).rows).toEqual([{status:'cancelled',attempts:2}]);expect(sends).toBe(1);
 expect((await execute(recipient,{kind:'clientAction',callbackId:cb.id},'83',clock)).status).toBe('declined');
 expect((await admin.query('SELECT kind FROM holds WHERE visit_id=$1',[v])).rows).toEqual([{kind:'visit'}]);
},120000);
it.each(['move','cancel'] as const)('delivery review accepted result retry after %s is fenced by current scheduling truth',async outcome=>{
 const v=await confirmed(),t1=await execute('200',move(v,'2026-11-06T10:00:00.000Z','proposeTransfer'),'82');expect(t1.status).toBe('pending');expect((await execute('100',decision(t1.entityId!),'83')).status).toBe('accepted');
 const first=await deliveryTarget(t1.entityId!,'transfer_accepted','100');await isolateDelivery(first.id);let firstSends=0;
 await new Outbox(db(),{send:async()=>{firstSends++;throw new DeliveryError('transient');}}).deliver(now,1);expect(firstSends).toBe(1);
 const next='2026-11-06T04:00:01.000Z';
 if(outcome==='move'){
  const t2=await execute('200',move(v,'2026-11-06T12:00:00.000Z','proposeTransfer',3),'84',next);expect(t2.status).toBe('pending');expect((await execute('100',decision(t2.entityId!),'85',next)).status).toBe('accepted');
  const second=await deliveryTarget(t2.entityId!,'transfer_accepted','100');await isolateDelivery(first.id,second.id);const sent:Delivery[]=[];
  await new Outbox(db(next),{send:async d=>{sent.push(d);return {messageId:'new-current-result'};}}).deliver(next,1);expect(sent.map(d=>d.entityId)).toEqual([t2.entityId]);
  const immutable=(await admin.query('SELECT * FROM outbox WHERE id=$1',[second.id])).rows[0];expect(immutable.status).toBe('sent');
  await admin.query("UPDATE outbox SET status='leased',claim_token=gen_random_uuid(),lease_until='2026-11-06T04:00:02Z' WHERE id=$1",[first.id]);
  const later='2026-11-06T04:00:03.000Z';await new Outbox(db(later),{send:async()=>{firstSends++;return {messageId:'stale'};}}).deliver(later,1);
  expect((await admin.query('SELECT * FROM outbox WHERE id=$1',[second.id])).rows[0]).toEqual(immutable);
 }else{
  expect((await execute('100',{kind:'cancelBooking',visitId:v,expectedVersion:3,purpose:'client'},'84',next)).status).toBe('cancelled');
  await isolateDelivery(first.id);
  const later='2026-11-06T04:00:03.000Z';await new Outbox(db(later),{send:async()=>{firstSends++;return {messageId:'stale'};}}).deliver(later,1);
 }
 expect(firstSends).toBe(1);expect((await admin.query('SELECT status,attempts FROM outbox WHERE id=$1',[first.id])).rows).toEqual([{status:'cancelled',attempts:2}]);
},120000);
it('delivery review first-contact cancellation still notifies the current staff author',async()=>{
 const v=await confirmed(),manual=(await admin.query("INSERT INTO clients(name,phone) VALUES('Manual delivery fixture','+79123456781') RETURNING id")).rows[0].id;await admin.query('UPDATE visits SET client_id=$2 WHERE id=$1',[v,manual]);
 const t=await execute('200',move(v,'2026-11-06T10:00:00.000Z','proposeTransfer'),'82');expect(t.status).toBe('pending');
 await execute('300',{kind:'start',payload:null},'83');const clock='2026-11-06T04:00:01.000Z';await db(clock).transaction(tx=>acceptContact({telegramId:'300'},{userId:'300',phone:'+79123456781'},tx));
 const target=await deliveryTarget(t.entityId!,'transfer_cancelled','200');await isolateDelivery(target.id);const sent:Delivery[]=[];
 await new Outbox(db(clock),{send:async d=>{sent.push(d);return {messageId:'link-cancel'};}}).deliver(clock,1);expect(sent).toHaveLength(1);expect((sent[0].payload as {text:string}).text).toContain('Требуется новое предложение');expect((await admin.query('SELECT status FROM outbox WHERE id=$1',[target.id])).rows[0].status).toBe('sent');
},120000);
