import pg from 'pg';
import { beforeAll,beforeEach,afterAll,expect,it } from 'vitest';
import { testDatabaseUrl } from './safety';
import { migrate } from '../../scripts/migrate';
import { seed } from '../../scripts/seed';
import { nodeDatabase } from '../../scripts/node-db';
import { Repository } from '../../src/db/repository';
import { Outbox } from '../../src/notifications/outbox';
import { DeliveryError } from '../../src/notifications/transport';
import { hashToken } from '../../src/identity/service';
import type { Database } from '../../src/db/client';
import type { Command } from '../../src/domain/types';
const schema=`stage7_${crypto.randomUUID().replaceAll('-','')}`;
const scoped=new URL(testDatabaseUrl());scoped.searchParams.set('options',`-c search_path=${schema}`);
const now='2026-11-06T04:00:00.000Z',start='2026-11-07T18:00:00.000Z',barber='00000000-0000-4000-8000-000000000002';
let sql:pg.Client,created=false,update=70000;
const db=(clock=now):Database=>{const base=nodeDatabase(scoped.toString());return {read:base.read,transaction:run=>base.transaction(tx=>run({...tx,now:clock}))};};
const execute=(command:Command,id='100',clock=now,updateId=String(update++))=>new Repository(db(clock)).execute({telegramId:id},command,updateId);
async function own(){await execute({kind:'start',payload:null});return (await sql.query('SELECT c.id,u.id user_id FROM clients c JOIN telegram_users u ON u.id=c.user_id WHERE u.telegram_id=100')).rows[0];}
async function visit(status='confirmed',clock=start){const c=await own();return (await sql.query('INSERT INTO visits(client_id,barber_id,status,start_at,end_at,deadline,created_at) VALUES($1,$2,$3,$4,$4::timestamptz+interval \'45 minutes\',$5,$6) RETURNING *',[c.id,barber,status,clock,'2026-11-06T05:00:00.000Z',now])).rows[0];}
const reminders=async()=> (await sql.query("SELECT * FROM outbox WHERE kind='reminder' ORDER BY due_at")).rows;
async function screen(){return (await sql.query("SELECT payload FROM outbox WHERE kind='client_screen' AND chat_id=100 AND status='pending' ORDER BY due_at,id")).rows.at(-1)?.payload;}
async function click(label:string){const s=await screen();const b=s?.reply_markup.inline_keyboard.flat().find((b:any)=>b.text.includes(label));expect(b,JSON.stringify(s)).toBeTruthy();return execute({kind:'clientAction',callbackId:b.callback_data});}
beforeAll(async()=>{sql=new pg.Client({connectionString:scoped.toString(),connectionTimeoutMillis:5000});await sql.connect();await sql.query(`CREATE SCHEMA "${schema}"`);created=true;await migrate(scoped.toString());await seed(scoped.toString());});
afterAll(async()=>{if(created)await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await sql?.end();});
beforeEach(async()=>{await sql.query('TRUNCATE outbox,jobs,telegram_users,clients,visits,barbers CASCADE');await seed(scoped.toString());});
it('legacy ensure schedules future reminders; changed preference moves unsent but same value preserves lease/retry',async()=>{
  const v=await visit();await execute({kind:'start',payload:null});expect(await reminders()).toHaveLength(2);
  const near=(await reminders()).find(r=>r.payload.reminderKind==='near');expect(near.due_at.toISOString()).toBe('2026-11-07T16:00:00.000Z');
  await sql.query("UPDATE outbox SET status='leased',attempts=3,claim_token=gen_random_uuid(),lease_until=$2, due_at=$3 WHERE id=$1",[near.id,'2026-11-06T04:01:00.000Z','2026-11-06T03:59:00.000Z']);
  const before=(await sql.query('SELECT * FROM outbox WHERE id=$1',[near.id])).rows[0];
  expect((await execute({kind:'setReminderHours',hours:2} as Command)).status).toBe('reminder_updated');
  expect((await sql.query('SELECT * FROM outbox WHERE id=$1',[near.id])).rows[0]).toEqual(before);
  await execute({kind:'setReminderHours',hours:5} as Command);const changed=(await sql.query('SELECT * FROM outbox WHERE id=$1',[near.id])).rows[0];
  expect(changed.status).toBe('pending');expect(changed.claim_token).toBeNull();expect(changed.attempts).toBe(3);expect(changed.due_at.toISOString()).toBe('2026-11-07T13:00:00.000Z');
  expect((await sql.query('SELECT version FROM visits WHERE id=$1',[v.id])).rows[0].version).toBe(1);
},120000);
it('sent class is terminal across preference toggles and ownership-only version changes',async()=>{
  const v=await visit();await execute({kind:'start',payload:null});await sql.query("UPDATE outbox SET status='sent',sent_at=$1 WHERE kind='reminder'",[now]);
  await execute({kind:'setReminderHours',hours:5} as Command);await execute({kind:'setReminderHours',hours:1} as Command);
  await sql.query('UPDATE visits SET version=version+1 WHERE id=$1',[v.id]);await execute({kind:'start',payload:null});
  expect((await reminders()).map(r=>r.status)).toEqual(['sent','sent']);
},120000);
it('management is available before profile and after submit; cancel requires affirmative own current callback and releases work',async()=>{
  const v=await visit();await sql.query("UPDATE drafts SET state=state||'{\"submitted\":true}'::jsonb");
  await sql.query("INSERT INTO holds(visit_id,barber_id,kind,start_at,end_at) VALUES($1,$2,'visit',$3,$4)",[v.id,barber,v.start_at,v.end_at]);
  const t=(await sql.query(`INSERT INTO transfers(visit_id,initiator,status,new_start_at,new_end_at,deadline,initiator_user_id,context)
    SELECT v.id,'staff','pending',$2::timestamptz+interval '1 day',$2::timestamptz+interval '1 day 45 minutes',$3,c.user_id,
      jsonb_build_object('visitVersion',v.version,'clientId',v.client_id,'clientUserId',c.user_id,'barberId',v.barber_id,'oldStart',v.start_at,'oldEnd',v.end_at,'scheduleGeneration',v.schedule_generation)
    FROM visits v JOIN clients c ON c.id=v.client_id WHERE v.id=$1 RETURNING id`,[v.id,start,'2026-11-06T05:00:00Z'])).rows[0].id;
  await sql.query("INSERT INTO holds(visit_id,transfer_id,barber_id,kind,start_at,end_at,expires_at) VALUES($1,$2,$3,'transfer',$4::timestamptz+interval '1 day',$4::timestamptz+interval '1 day 45 minutes',$5)",[v.id,t,barber,start,'2026-11-06T05:00:00Z']);
  await sql.query("INSERT INTO jobs(logical_key,kind,visit_id,entity_version,due_at) VALUES('cleanup-proof','expire_visit',$1,1,$2)",[v.id,'2026-11-06T05:00:00Z']);
  await execute({kind:'setReminderHours',hours:2});await sql.query("UPDATE outbox SET status='leased',claim_token=gen_random_uuid(),lease_until=$1 WHERE kind='reminder' AND payload->>'reminderKind'='near'",['2026-11-06T04:01:00Z']);
  expect(await reminders()).toHaveLength(2);expect((await sql.query('SELECT * FROM holds')).rows).toHaveLength(2);
  await click('Мои записи');expect((await screen()).text).toContain('МСК');await click('Отменить');
  expect((await sql.query('SELECT status FROM visits WHERE id=$1',[v.id])).rows[0].status).toBe('confirmed');await click('Да, отменить');
  expect((await sql.query('SELECT status FROM visits WHERE id=$1',[v.id])).rows[0].status).toBe('cancelled');expect((await reminders()).every(r=>r.status==='cancelled')).toBe(true);
  expect((await sql.query('SELECT * FROM holds')).rows).toHaveLength(0);expect((await sql.query('SELECT status FROM jobs')).rows).toEqual([{status:'cancelled'}]);expect((await sql.query('SELECT status FROM transfers WHERE id=$1',[t])).rows[0].status).toBe('cancelled');expect((await reminders()).every(r=>r.claim_token===null)).toBe(true);
},120000);
it('current preference at staff confirmation persists to next visit; invalid hours never change settings',async()=>{
 const v=await visit('pending');await execute({kind:'setReminderHours',hours:5});
 const c=await own();await sql.query("INSERT INTO roles(user_id,role) VALUES($1,'admin')",[c.user_id]);expect((await execute({kind:'confirmBooking',visitId:v.id,expectedVersion:1})).status).toBe('confirmed');
 expect((await reminders()).find(r=>r.payload.reminderKind==='near').due_at.toISOString()).toBe('2026-11-07T13:00:00.000Z');
 for(const hours of [0,6,1.5,NaN])expect((await execute({kind:'setReminderHours',hours})).status).toBe('invalid_reminder_hours');expect((await sql.query('SELECT reminder_hours FROM clients WHERE id=$1',[c.id])).rows[0].reminder_hours).toBe(5);
},120000);
it('first own contact links only future manual visits and retains sent class history across new ownership version',async()=>{
 const c=await own();const manual=(await sql.query("INSERT INTO clients(name,phone) VALUES('Ручной тест','+79123456789') RETURNING id")).rows[0].id;
 const v=(await sql.query("INSERT INTO visits(client_id,barber_id,status,start_at,end_at,created_at) VALUES($1,$2,'confirmed',$3,$3::timestamptz+interval '45 minutes',$4) RETURNING id",[manual,barber,start,now])).rows[0].id;
 await sql.query("INSERT INTO outbox(logical_key,kind,chat_id,payload,due_at,entity_id,entity_version,entity_type,status,sent_at) VALUES('manual-sent-day','reminder',100,$1::jsonb,$2,$3,1,'visit','sent',$2),('manual-pending-near','reminder',100,$4::jsonb,$2,$3,1,'visit','leased',NULL)",[JSON.stringify({text:'Тест',reminderKind:'day',scheduledStart:start}),now,v,JSON.stringify({text:'Тест',reminderKind:'near',scheduledStart:start})]);
 await execute({kind:'updateContact',contact:{userId:'100',phone:'+79123456789'}});
 expect((await sql.query('SELECT client_id,version FROM visits WHERE id=$1',[v])).rows[0]).toEqual({client_id:c.id,version:2});const rows=await reminders();expect(rows.filter(r=>r.status==='sent')).toHaveLength(1);expect(rows.filter(r=>r.status==='pending')).toHaveLength(1);expect(rows.find(r=>r.status==='pending').entity_version).toBe(2);expect(rows.find(r=>r.logical_key==='manual-pending-near').status).toBe('cancelled');
 await execute({kind:'updateContact',contact:{userId:'100',phone:'+79123456790'}});expect((await sql.query('SELECT client_id,version FROM visits WHERE id=$1',[v])).rows[0]).toEqual({client_id:c.id,version:2});expect(await reminders()).toHaveLength(3);
},120000);
it.each(['success','transient'] as const)('preference change fences late %s acknowledgement without resetting history',async outcome=>{
 const v=await visit();await execute({kind:'start',payload:null});await sql.query("UPDATE outbox SET status='cancelled' WHERE kind<>'reminder'");await sql.query("UPDATE outbox SET due_at=$1 WHERE kind='reminder' AND payload->>'reminderKind'='near'",[now]);
 let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),released=new Promise<void>(r=>{release=r;});
 const sending=new Outbox(db(),{send:async()=>{entered();await released;if(outcome==='transient')throw new DeliveryError('transient');return {messageId:'late'};}}).deliver(now,1);
 await reached;await execute({kind:'setReminderHours',hours:5});release();await sending;
 const near=(await reminders()).find(r=>r.payload.reminderKind==='near');expect(near.status).toBe('pending');expect(near.message_id).toBeNull();expect(near.claim_token).toBeNull();expect(near.attempts).toBe(1);expect(near.due_at.toISOString()).toBe('2026-11-07T13:00:00.000Z');
},120000);
it('historical confirmation cutoff skips past day while ensure preserves overdue valid work and non-null sent_at stays terminal',async()=>{
 const v=await visit();const c=(await sql.query('SELECT c.id,u.id user_id FROM clients c JOIN telegram_users u ON u.id=c.user_id WHERE u.telegram_id=100')).rows[0];await sql.query("INSERT INTO audit_events(update_id,actor_id,kind,entity_id,created_at) VALUES($1,$2,'visit_confirmed',$3,$4)",[String(update++),c.user_id,v.id,'2026-11-06T20:00:00Z']);
 const later='2026-11-07T12:00:00.000Z';await execute({kind:'start',payload:null},'100',later);expect((await reminders()).map(r=>r.payload.reminderKind)).toEqual(['near']);
 const near=(await reminders())[0];await sql.query("UPDATE outbox SET status='leased',due_at=$2,attempts=2,claim_token=gen_random_uuid(),lease_until=$3 WHERE id=$1",[near.id,'2026-11-07T11:59:00Z','2026-11-07T12:01:00Z']);const before=(await sql.query('SELECT * FROM outbox WHERE id=$1',[near.id])).rows[0];
 await execute({kind:'start',payload:null},'100',later);expect((await sql.query('SELECT * FROM outbox WHERE id=$1',[near.id])).rows[0]).toEqual(before);
 await sql.query("UPDATE outbox SET status='cancelled',sent_at=$2 WHERE id=$1",[near.id,later]);await execute({kind:'setReminderHours',hours:5},'100',later);expect((await reminders())[0].status).toBe('cancelled');expect(await reminders()).toHaveLength(1);
},120000);
it('personal entry lists all own barbers with bounded pages and restores the original new-booking lock',async()=>{
 const c=await own(),token='stage7-personal-master-token-00000000000000';await sql.query('UPDATE barbers SET public_token_hash=$1 WHERE id=$2',[await hashToken(token),barber]);
 const other=(await sql.query("INSERT INTO barbers(name) VALUES('Второй собственный мастер') RETURNING id")).rows[0].id;
 await sql.query("INSERT INTO visits(client_id,barber_id,status,start_at,end_at,created_at) SELECT $1,CASE WHEN n=1 THEN $2::uuid ELSE $3::uuid END,'confirmed',$4::timestamptz+n*interval '1 hour',$4::timestamptz+n*interval '1 hour'+interval '45 minutes',$5 FROM generate_series(1,7) n",[c.id,other,barber,start,now]);
 await execute({kind:'start',payload:`b_${token}`});await click('Мои записи');expect((await screen()).text).toContain('Второй собственный мастер');expect((await screen()).reply_markup.inline_keyboard.flat().filter((b:any)=>b.text.startsWith('Отменить'))).toHaveLength(5);
 await click('›');expect((await screen()).reply_markup.inline_keyboard.flat().filter((b:any)=>b.text.startsWith('Отменить'))).toHaveLength(2);await click('К записи');const d=(await sql.query('SELECT barber_id,state FROM drafts WHERE user_id=$1',[c.user_id])).rows[0];expect(d.barber_id).toBe(barber);expect(d.state.lockedBarber).toBe(true);expect(d.state.view).toBe('services');expect((await screen()).reply_markup.inline_keyboard.flat().some((b:any)=>b.text==='Назад')).toBe(false);
},120000);
it('own-client purpose cannot use cumulative admin privileges or cancel after start; pending withdraw is owner-only',async()=>{
  const v=await visit();const c=await own();await sql.query("INSERT INTO roles(user_id,role) VALUES($1,'admin')",[c.user_id]);
  expect((await execute({kind:'cancelBooking',visitId:v.id,expectedVersion:1,purpose:'client'} as Command,'101')).status).toBe('forbidden');
  await execute({kind:'start',payload:null},'101');const other=(await sql.query('SELECT c.id FROM clients c JOIN telegram_users u ON u.id=c.user_id WHERE u.telegram_id=101')).rows[0].id;
  await sql.query('UPDATE visits SET client_id=$1 WHERE id=$2',[other,v.id]);expect((await execute({kind:'cancelBooking',visitId:v.id,expectedVersion:1,purpose:'client',reason:'admin'} as Command)).status).toBe('forbidden');await sql.query('UPDATE visits SET client_id=$1 WHERE id=$2',[c.id,v.id]);
  await sql.query("UPDATE visits SET status='pending' WHERE id=$1",[v.id]);expect((await execute({kind:'withdrawBooking',visitId:v.id,expectedVersion:1} as Command)).status).toBe('cancelled');
  await sql.query("UPDATE visits SET status='confirmed',version=1 WHERE id=$1",[v.id]);expect((await execute({kind:'cancelBooking',visitId:v.id,expectedVersion:1,purpose:'client',reason:'admin'} as Command,'100',start)).status).toBe('already_started');
},120000);
it('delivery refuses a current-version reminder to wrong owner and at exact visit start',async()=>{
  const v=await visit();await sql.query(`INSERT INTO outbox(logical_key,kind,chat_id,payload,due_at,entity_id,entity_version,entity_type) VALUES('test:day','reminder',100,$1::jsonb,$2,$3,1,'visit'),('test:near','reminder',100,$1::jsonb,$2,$3,1,'visit')`,[JSON.stringify({text:'Тестовое напоминание',reminderKind:'near',scheduledStart:start}),now,v.id]);expect(await reminders()).toHaveLength(2);await sql.query("UPDATE outbox SET status='cancelled' WHERE kind<>'reminder'");
  await sql.query("UPDATE outbox SET due_at=$1,chat_id=101 WHERE kind='reminder'",[now]);let sends=0;
  await new Outbox(db(),{send:async()=>{sends++;return {messageId:'1'};}}).deliver(now,5);expect(sends).toBe(0);expect((await reminders()).every(r=>r.status==='cancelled')).toBe(true);
  await sql.query("UPDATE outbox SET status='pending',chat_id=100 WHERE kind='reminder'");await new Outbox(db(start),{send:async()=>{sends++;return {messageId:'1'};}}).deliver(start,5);expect(sends).toBe(0);
},120000);
