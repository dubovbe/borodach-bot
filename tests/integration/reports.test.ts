import pg from 'pg';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {testDatabaseUrl} from './safety';
import {migrate} from '../../scripts/migrate';
import {seed} from '../../scripts/seed';
import {nodeDatabase} from '../../scripts/node-db';
import {Repository} from '../../src/db/repository';
import type {Database} from '../../src/db/client';
import type {Command} from '../../src/domain/types';
import {getReport} from '../../src/reports/service';
import {prepareManual,executeStaff} from '../../src/booking/staff-service';
import {Outbox} from '../../src/notifications/outbox';

const schema=`stage10_${crypto.randomUUID().replaceAll('-','')}`;
const scoped=new URL(testDatabaseUrl());scoped.searchParams.set('options',`-c search_path=${schema}`);
const now='2026-11-06T04:00:00.000Z',start='2026-11-06T07:00:00.000Z';
const barber='00000000-0000-4000-8000-000000000002',service='00000000-0000-4000-8000-000000000003';
let sql:pg.Client,created=false,update=100000;
const db=(clock=now):Database=>{const base=nodeDatabase(scoped.toString());return {read:base.read,transaction:run=>base.transaction(tx=>run({...tx,now:clock}))};};
const execute=(command:Command,id='100',clock=now)=>new Repository(db(clock)).execute({telegramId:id},command,String(update++));
async function confirmed(){
 const request=await execute({kind:'requestBooking',barberId:barber,serviceIds:[service],start});
 expect(request.status).toBe('pending');expect(request.entityId).toBeTruthy();
 const result=await execute({kind:'confirmBooking',visitId:request.entityId!,expectedVersion:1},'200');
 expect(result.status).toBe('confirmed');return request.entityId!;
}
beforeAll(async()=>{sql=new pg.Client({connectionString:scoped.toString(),connectionTimeoutMillis:5000});await sql.connect();await sql.query(`CREATE SCHEMA "${schema}"`);created=true;await migrate(scoped.toString());await seed(scoped.toString());});
afterAll(async()=>{if(created)await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await sql?.end();});
beforeEach(async()=>{
 await sql.query('TRUNCATE outbox,jobs,telegram_users,clients,visits,barbers CASCADE');await seed(scoped.toString());
 await sql.query('UPDATE rank_tariffs SET price_kopecks=150000,duration_minutes=45');
 for(let day=1;day<=7;day++)await sql.query('INSERT INTO weekly_hours(barber_id,weekday,start_minute,end_minute) VALUES($1,$2,0,1440)',[barber,day]);
 for(const id of ['100','200','300']){
  const uid=(await sql.query('INSERT INTO telegram_users(telegram_id,last_seen_at) VALUES($1,$2) RETURNING id',[id,now])).rows[0].id;
  await sql.query("INSERT INTO roles(user_id,role) VALUES($1,$2)",[uid,id==='200'?'barber':id==='300'?'admin':'client']);
  if(id==='200')await sql.query('UPDATE barbers SET user_id=$1 WHERE id=$2',[uid,barber]);
  if(id==='100'){
   const cid=(await sql.query("INSERT INTO clients(user_id,name,phone) VALUES($1,'Вымышленный Клиент','+79123456100') RETURNING id",[uid])).rows[0].id;
   await sql.query("INSERT INTO phone_claims(client_id,user_id,phone,claimed_at) VALUES($1,$2,'+79123456100',$3)",[cid,uid,now]);
  }
 }
});
it('Stage10 manual is confirmed inside client lead time with snapshots, permanent hold and no invented unlinked delivery',async()=>{
 await confirmed();
 const result=await execute({kind:'createManualBooking',barberId:barber,clientName:'Ручной Клиент',phone:'8 912 345-61-01',serviceIds:[service],start:'2026-11-06T04:30:00.000Z'} as unknown as Command,'200');
 expect(result.status).toBe('confirmed');
 const v=(await sql.query('SELECT v.*,c.user_id,c.phone FROM visits v JOIN clients c ON c.id=v.client_id WHERE v.id=$1',[result.entityId])).rows[0];
 expect(v.status).toBe('confirmed');expect(v.user_id).toBeNull();expect(v.phone).toBe('+79123456101');
 expect((await sql.query('SELECT price_kopecks,duration_minutes FROM visit_items WHERE visit_id=$1',[v.id])).rows).toEqual([{price_kopecks:150000,duration_minutes:45}]);
 expect((await sql.query('SELECT expires_at FROM holds WHERE visit_id=$1',[v.id])).rows).toEqual([{expires_at:null}]);
 expect((await sql.query("SELECT * FROM jobs WHERE visit_id=$1 AND kind='expire_visit'",[v.id])).rows).toHaveLength(0);
 expect((await sql.query("SELECT * FROM outbox WHERE entity_id=$1 AND (kind='reminder' OR chat_id=100)",[v.id])).rows).toHaveLength(0);
 expect((await sql.query("SELECT created_at FROM audit_events WHERE entity_id=$1 AND kind='visit_confirmed'",[v.id])).rows[0].created_at.toISOString()).toBe(now);
},120000);
it('Stage10 outcome gates start and authority, closes work, and admin alone corrects with an audited reason',async()=>{
 const id=await confirmed();
 const mark={kind:'markOutcome',visitId:id,expectedVersion:2,outcome:'completed'} as unknown as Command;
 expect((await execute(mark,'200')).status).toBe('not_started');
 expect((await execute(mark,'100',start)).status).toBe('forbidden');
 expect((await execute(mark,'200',start)).status).toBe('completed');
 expect((await sql.query('SELECT * FROM holds WHERE visit_id=$1',[id])).rows).toHaveLength(0);
 expect((await sql.query("SELECT * FROM outbox WHERE entity_id=$1 AND status IN ('pending','leased')",[id])).rows).toHaveLength(0);
 const correction={kind:'correctOutcome',visitId:id,expectedVersion:3,outcome:'no_show',reason:'Ошибочно выбран результат'} as unknown as Command;
 expect((await execute(correction,'200',start)).status).toBe('forbidden');
 expect((await execute(correction,'300',start)).status).toBe('no_show');
 expect((await sql.query('SELECT status,version,schedule_generation FROM visits WHERE id=$1',[id])).rows[0]).toEqual({status:'no_show',version:4,schedule_generation:1});
 const audit=(await sql.query("SELECT data FROM audit_events WHERE entity_id=$1 AND kind='visit_outcome_corrected'",[id])).rows[0];
 expect(audit.data).toMatchObject({oldOutcome:'completed',newOutcome:'no_show',reason:'Ошибочно выбран результат'});
 expect(await getReport({telegramId:'300'},{fromLocalDate:'2026-11-06',toLocalDate:'2026-11-06'},db())).toEqual({completed:0,noShows:1,serviceValueKopecks:0});
},120000);
it('Stage10 reports count immutable completed snapshots by Moscow start date and reject foreign/client scope',async()=>{
 const id=await confirmed();
 // Isolate the report target from the separately tested outcome command.
 await sql.query("UPDATE visits SET status='completed' WHERE id=$1",[id]);
 await sql.query('UPDATE rank_tariffs SET price_kopecks=999');
 const input={fromLocalDate:'2026-11-06',toLocalDate:'2026-11-06'};
 expect(await getReport({telegramId:'200'},input,db())).toEqual({completed:1,noShows:0,serviceValueKopecks:150000});
 expect(await getReport({telegramId:'300'},input,db())).toEqual({completed:1,noShows:0,serviceValueKopecks:150000});
 await expect(getReport({telegramId:'100'},input,db())).rejects.toMatchObject({code:'forbidden'});
 await expect(getReport({telegramId:'200'},{...input,barberId:'00000000-0000-4000-8000-000000000099'},db())).rejects.toMatchObject({code:'forbidden'});
 expect(await getReport({telegramId:'200'},{fromLocalDate:'2026-11-07',toLocalDate:'2026-11-07'},db())).toEqual({completed:0,noShows:0,serviceValueKopecks:0});
},120000);
const manual=(extra:Record<string,unknown>={})=>({kind:'createManualBooking',barberId:barber,clientName:'Ручной Клиент',phone:'+79123456101',serviceIds:[service],start:'2026-11-06T04:30:00.000Z',...extra}) as Extract<Command,{kind:'createManualBooking'}>;
const uid=async(id:string)=>(await sql.query('SELECT id FROM telegram_users WHERE telegram_id=$1',[id])).rows[0].id as string;
it('manual rejects past/grid/busy/foreign scope and binds a current claim without editing its canonical contact',async()=>{
 for(const start of ['2026-11-06T03:30:00Z','2026-11-06T04:31:00Z'])expect((await execute(manual({start}),'200')).status).toBe('slot_unavailable');
 expect((await execute(manual(),'100')).status).toBe('forbidden');
 const before=(await sql.query('SELECT * FROM clients WHERE user_id=$1',[await uid('100')])).rows[0];
 expect((await execute(manual({phone:before.phone}),'200')).status).toBe('quote_conflict');
 const result=await execute(manual({phone:before.phone,clientName:before.name}),'200');expect(result.status).toBe('confirmed');
 expect((await sql.query('SELECT client_id FROM visits WHERE id=$1',[result.entityId])).rows[0].client_id).toBe(before.id);
 expect((await sql.query('SELECT * FROM clients WHERE id=$1',[before.id])).rows[0]).toEqual(before);
 expect((await execute(manual(),'200')).status).toBe('slot_unavailable');
 expect((await execute(manual({start:'2026-11-06T05:30:00Z'}),'200')).status).toBe('confirmed');
},120000);
it('manual review detects a new phone claim and empty canonical name is audit fallback, never a profile edit',async()=>{
 const actor=await uid('200'),command=manual();
 const old=await db().transaction(tx=>prepareManual({tx,userId:actor,updateId:String(update++)},command));
 const owner=await uid('100');await sql.query("UPDATE clients SET name='',phone=$2 WHERE user_id=$1",[owner,command.phone]);
 await sql.query('UPDATE phone_claims SET phone=$2 WHERE user_id=$1 AND released_at IS NULL',[owner,command.phone]);
 await expect(db().transaction(tx=>executeStaff({tx,userId:actor,updateId:String(update++)},command,old.fingerprint))).rejects.toMatchObject({code:'quote_conflict'});
 const result=await execute(command,'200');expect(result.status).toBe('confirmed');
 expect((await sql.query('SELECT name FROM clients WHERE user_id=$1',[owner])).rows[0].name).toBe('');
 expect((await sql.query("SELECT data FROM audit_events WHERE entity_id=$1 AND kind='visit_confirmed'",[result.entityId])).rows[0].data.manualClientName).toBe(command.clientName);
},120000);
it('manual reuses only exact unlinked name/phone; stale phone and released claims never grant ownership',async()=>{
 const stale=(await sql.query("INSERT INTO clients(name,phone) VALUES('Другое имя',$1) RETURNING id",[manual().phone])).rows[0].id;
 await sql.query('UPDATE clients SET phone=$2 WHERE user_id=$1',[await uid('100'),manual().phone]);
 await sql.query('UPDATE phone_claims SET released_at=$2 WHERE user_id=$1',[await uid('100'),now]);
 const first=await execute(manual(),'200');expect(first.status).toBe('confirmed');
 const second=await execute(manual({start:'2026-11-06T05:30:00Z'}),'200');expect(second.status).toBe('confirmed');
 const rows=(await sql.query('SELECT client_id FROM visits ORDER BY start_at')).rows;expect(rows[0].client_id).toBe(rows[1].client_id);expect(rows[0].client_id).not.toBe(stale);
 expect((await sql.query('SELECT user_id FROM clients WHERE id=$1',[rows[0].client_id])).rows[0].user_id).toBeNull();
},120000);
it('staff cancellation always requires reason even for own client and delayed delivery mints fresh navigation without touching draft',async()=>{
 const id=await confirmed();const own=await uid('100');await sql.query("INSERT INTO roles(user_id,role) VALUES($1,'admin')",[own]);
 await execute({kind:'start',payload:null});const draft=(await sql.query('SELECT * FROM drafts WHERE user_id=$1',[own])).rows[0];
 for(const reason of ['', 'Причина\nстрока','\u200b'])expect((await execute({kind:'staffCancelBooking',visitId:id,expectedVersion:2,reason})).status).toBe('invalid_input');
 expect((await execute({kind:'staffCancelBooking',visitId:id,expectedVersion:2,reason:'Мастер заболел'})).status).toBe('cancelled');
 expect((await sql.query('SELECT * FROM entry_callbacks')).rows).toHaveLength(0);
 await sql.query("UPDATE outbox SET status='cancelled' WHERE NOT (kind='booking' AND payload->>'event'='visit_cancelled' AND chat_id=100)");
 const sent:any[]=[];const delayed='2026-11-06T05:00:00.000Z';await new Outbox(db(delayed),{send:async d=>{sent.push(d);return {messageId:'entry'};}}).deliver(delayed,5);
 expect(sent).toHaveLength(1);expect(sent[0].payload.text).toContain('Мастер заболел');
 const button=sent[0].payload.reply_markup.inline_keyboard[0][0];expect(button.text).toBe('Новая запись');
 const entry=(await sql.query('SELECT * FROM entry_callbacks WHERE id=$1',[button.callback_data])).rows[0];expect(entry.expires_at.toISOString()).toBe('2026-11-06T05:30:00.000Z');
 expect((await sql.query('SELECT * FROM drafts WHERE id=$1',[draft.id])).rows[0]).toEqual(draft);
 expect((await execute({kind:'clientAction',callbackId:entry.id},'200',delayed)).status).toBe('forbidden');
 expect((await execute({kind:'clientAction',callbackId:entry.id},'100',delayed)).status).toBe('started');
 expect((await execute({kind:'clientAction',callbackId:entry.id},'100',delayed)).status).toBe('stale_callback');
 expect((await sql.query('SELECT status,version FROM visits WHERE id=$1',[id])).rows[0]).toEqual({status:'cancelled',version:3});
},120000);
it('reports use Moscow start boundaries, count visits once, aggregate bigint snapshots, and retain archived history',async()=>{
 const client=(await sql.query('SELECT id FROM clients WHERE user_id=$1',[await uid('100')])).rows[0].id;
 for(const [at,status,price] of [['2026-11-05T20:59:59Z','completed',111],['2026-11-05T21:00:00Z','completed',2147483647],['2026-11-06T20:59:59Z','completed',2147483647],['2026-11-06T21:00:00Z','completed',222],['2026-11-06T10:00:00Z','no_show',999],['2026-11-06T11:00:00Z','cancelled',999]] as const){
  const id=(await sql.query('INSERT INTO visits(client_id,barber_id,status,start_at,end_at,created_at) VALUES($1,$2,$3,$4,$4::timestamptz+interval \'45 minutes\',$5) RETURNING id',[client,barber,status,at,now])).rows[0].id;
  await sql.query("INSERT INTO visit_items(visit_id,service_id,name,price_kopecks,duration_minutes) VALUES($1,$2,'Снимок',$3,45),($1,$2,'Второй снимок',1,1)",[id,service,price]);
 }
 await sql.query('UPDATE barbers SET archived_at=$1 WHERE id=$2',[now,barber]);
 const input={fromLocalDate:'2026-11-06',toLocalDate:'2026-11-06'};
 expect(await getReport({telegramId:'200'},input,db())).toEqual({completed:2,noShows:1,serviceValueKopecks:4294967296});
 expect(await getReport({telegramId:'300'},{...input,barberId:barber},db())).toEqual({completed:2,noShows:1,serviceValueKopecks:4294967296});
 await sql.query("DELETE FROM roles WHERE user_id=$1 AND role='barber'",[await uid('200')]);await expect(getReport({telegramId:'200'},input,db())).rejects.toMatchObject({code:'forbidden'});
},120000);
it('staff cancellation preserves legal pending-transfer cancellation delivery to the third admin author',async()=>{
 const id=await confirmed();
 const transfer=await execute({kind:'proposeTransfer',visitId:id,expectedVersion:2,newStart:'2026-11-06T08:00:00Z',reason:'Просьба изменить время'},'300');expect(transfer.status).toBe('pending');
 expect((await execute({kind:'staffCancelBooking',visitId:id,expectedVersion:2,reason:'Мастер заболел'},'200')).status).toBe('cancelled');
 const rows=(await sql.query("SELECT chat_id::text,payload FROM outbox WHERE entity_id=$1 AND status='pending' AND payload->>'event'='transfer_cancelled'",[transfer.entityId])).rows;
 expect(rows.some(r=>r.chat_id==='300')).toBe(true);expect((await sql.query('SELECT status FROM transfers WHERE id=$1',[transfer.entityId])).rows[0].status).toBe('cancelled');
 await sql.query("UPDATE outbox SET status='cancelled' WHERE NOT (entity_id=$1 AND chat_id=300 AND payload->>'event'='transfer_cancelled')",[transfer.entityId]);
 const deliveries:any[]=[];await new Outbox(db(),{send:async d=>{deliveries.push(d);return {messageId:'author'};}}).deliver(now,5);
 expect(deliveries).toHaveLength(1);expect(deliveries[0].chatId).toBe('300');expect(deliveries[0].payload.text).toContain('отмен');
},120000);
it('outcome honours legal transfer expiry precedence and fences leased reminder/decision work without customer outcome pushes',async()=>{
 const id=await confirmed();const transfer=await execute({kind:'proposeTransfer',visitId:id,expectedVersion:2,newStart:'2026-11-06T08:00:00Z',reason:'Новое время'},'300');expect(transfer.status).toBe('pending');
 const before=(await sql.query('SELECT * FROM visit_items WHERE visit_id=$1 ORDER BY id',[id])).rows;
 await sql.query("UPDATE outbox SET status='leased',claim_token=gen_random_uuid(),lease_until=$2 WHERE entity_id=$1 AND kind='reminder'",[id,'2026-11-06T07:01:00Z']);
 expect((await execute({kind:'markOutcome',visitId:id,expectedVersion:2,outcome:'completed'},'200',start)).status).toBe('completed');
 expect((await sql.query('SELECT status FROM transfers WHERE id=$1',[transfer.entityId])).rows[0].status).toBe('expired');
 expect((await sql.query("SELECT kind FROM audit_events WHERE entity_id=$1 AND kind='transfer_expired'",[transfer.entityId])).rows).toHaveLength(1);
 expect((await sql.query("SELECT * FROM outbox WHERE (entity_id=$1 OR entity_id=$2) AND status IN ('pending','leased')",[id,transfer.entityId])).rows).toHaveLength(0);
 expect((await sql.query('SELECT * FROM visit_items WHERE visit_id=$1 ORDER BY id',[id])).rows).toEqual(before);
 expect((await execute({kind:'correctOutcome',visitId:id,expectedVersion:3,outcome:'completed',reason:'Повтор'},'300',start)).status).toBe('invalid_state');
},120000);
