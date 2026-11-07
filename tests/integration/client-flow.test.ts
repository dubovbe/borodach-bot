import pg from 'pg';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { testDatabaseUrl } from './safety';
import { migrate } from '../../scripts/migrate';
import { seed } from '../../scripts/seed';
import { nodeDatabase } from '../../scripts/node-db';
import { Repository } from '../../src/db/repository';
import { Outbox } from '../../src/notifications/outbox';
import { DeliveryError } from '../../src/notifications/transport';
import { hashToken } from '../../src/identity/service';
import type { Command } from '../../src/domain/types';
import type { Database } from '../../src/db/client';
import type { Delivery } from '../../src/notifications/transport';
import { redeliverOnceOnLockTimeout } from './redelivery';
const schema=`stage6_${crypto.randomUUID().replaceAll('-','')}`;
const scoped=new URL(testDatabaseUrl()); scoped.searchParams.set('options',`-c search_path=${schema}`);
const now='2026-11-06T04:00:00.000Z', barber='00000000-0000-4000-8000-000000000002';
let sql:pg.Client, created=false, update=6000;
const db=(clock=now):Database=>{const base=nodeDatabase(scoped.toString()); return {read:base.read,transaction:run=>base.transaction(tx=>run({...tx,now:clock}))};};
const execute=(command:Command,id='100',clock=now,updateId=String(update++))=>new Repository(db(clock)).execute({telegramId:id},command,updateId);
async function screen(){return (await sql.query("SELECT payload FROM outbox WHERE kind='client_screen' AND chat_id=100 AND status='pending' ORDER BY due_at DESC,id DESC")).rows.at(-1)?.payload;}
async function button(label:string){const s=await screen(); const b=s?.reply_markup?.inline_keyboard.flat().find((b:any)=>label==='6'?b.text==='6':b.text.includes(label)); expect(b,JSON.stringify(s)).toBeTruthy(); return b.callback_data as string;}
const click=async(label:string)=>execute({kind:'clientAction',callbackId:await button(label)});
async function toSummary(){await execute({kind:'start',payload:null}); await click('Вымышленный мастер'); await click('Тестовая стрижка'); await click('Далее'); await click('6'); await click('10:00'); await execute({kind:'saveDraftInput',text:'Тестовый Клиент'}); await execute({kind:'updateContact',contact:{userId:'100',phone:'+79123456789'}}); expect((await screen()).text).toContain('Проверьте');}
beforeAll(async()=>{sql=new pg.Client({connectionString:scoped.toString(),connectionTimeoutMillis:5000});await sql.connect();await sql.query(`CREATE SCHEMA "${schema}"`);created=true;await migrate(scoped.toString());await seed(scoped.toString());});
afterAll(async()=>{if(created)await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await sql?.end();});
beforeEach(async()=>{await sql.query('TRUNCATE outbox,jobs,telegram_users,clients,visits,barbers CASCADE');await seed(scoped.toString());for(let d=1;d<=7;d++)await sql.query('INSERT INTO weekly_hours(barber_id,weekday,start_minute,end_minute) VALUES($1,$2,0,1200)',[barber,d]);const u=(await sql.query('INSERT INTO telegram_users(telegram_id,last_seen_at) VALUES(200,$1) RETURNING id',[now])).rows[0].id;await sql.query("INSERT INTO roles(user_id,role) VALUES($1,'barber')",[u]);await sql.query('UPDATE barbers SET user_id=$1 WHERE id=$2',[u,barber]);});
it('full persistent form only holds on submit, concurrent submit and replay create one pending, independent staff decision confirms details',async()=>{
  await toSummary();expect((await sql.query('SELECT * FROM holds')).rows).toHaveLength(0);
  const callbackId=await button('Отправить'),command:Command={kind:'clientAction',callbackId},firstId=String(update++),secondId=String(update++);const results=await Promise.all([redeliverOnceOnLockTimeout(()=>execute(command,'100',now,firstId)),redeliverOnceOnLockTimeout(()=>execute(command,'100',now,secondId))]);expect(results.filter(r=>r.status==='pending')).toHaveLength(1);
  expect((await sql.query('SELECT * FROM visits')).rows).toHaveLength(1);
  await execute({kind:'start',payload:null});
  const deliveries:Delivery[]=[];await new Outbox(db(),{send:async d=>{deliveries.push(d);return {messageId:'1'};}}).deliver(now,5);
  const staff=deliveries.find(d=>d.chatId==='200');expect((staff?.payload as any).text).toContain('Тестовый Клиент');expect((staff?.payload as any).text).toContain('+79123456789');
  const decision=(staff?.payload as any).reply_markup.inline_keyboard.flat()[0].callback_data;
  expect((await execute({kind:'clientAction',callbackId:decision},'101')).status).not.toBe('confirmed');
  expect((await execute({kind:'clientAction',callbackId:decision},'200')).status).toBe('confirmed');
  for(let i=0;i<3;i++)await new Outbox(db(),{send:async d=>{deliveries.push(d);return {messageId:'1'};}}).deliver(now,5);
  const confirmed=deliveries.find(d=>d.chatId==='100'&&(d.payload as any).text.includes('Запись подтверждена'));expect((confirmed?.payload as any).text).toContain('Вымышленная улица, 1');expect((confirmed?.payload as any).text).toContain('1500');
},120000);
it('reviewed quote change refreshes without pending and personal restart invalidates leased form',async()=>{
  await toSummary();const old=await button('Отправить');await sql.query('UPDATE rank_tariffs SET price_kopecks=price_kopecks+100');expect((await execute({kind:'clientAction',callbackId:old})).status).toBe('quote_conflict');expect((await sql.query('SELECT * FROM visits')).rows).toHaveLength(0);
  await sql.query("UPDATE outbox SET status='leased',claim_token=gen_random_uuid(),lease_until=$1::timestamptz+interval '30 seconds' WHERE kind='client_screen' AND status='pending'",[now]);
  const token='synthetic-personal-master-token-00000000000000';await sql.query('UPDATE barbers SET public_token_hash=$1 WHERE id=$2',[await hashToken(token),barber]);await execute({kind:'start',payload:`b_${token}`});expect((await screen()).text).toContain('услуг');expect((await sql.query("SELECT * FROM outbox WHERE kind='client_screen' AND status='leased'")).rows).toHaveLength(0);expect((await execute({kind:'clientAction',callbackId:old})).status).toBe('stale_callback');
},120000);
it('personal restriction, foreign/forged action, fixed TTL, expired useful restart and atomic rollback',async()=>{
  const token='synthetic-personal-master-token-00000000000000';await sql.query('UPDATE barbers SET public_token_hash=$1 WHERE id=$2',[await hashToken(token),barber]);
  await execute({kind:'start',payload:`b_${token}`});const form=(await sql.query('SELECT * FROM drafts')).rows[0];
  expect((await screen()).reply_markup.inline_keyboard.flat().some((b:any)=>b.text==='Назад')).toBe(false);
  const old=await button('Тестовая стрижка');expect((await execute({kind:'clientAction',callbackId:old},'101')).status).toBe('forbidden');
  const forged=crypto.randomUUID();await sql.query('INSERT INTO callbacks(id,user_id,draft_id,draft_version,action,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[forged,form.user_id,form.id,form.version,JSON.stringify({kind:'master',id:crypto.randomUUID()}),form.expires_at]);
  expect((await execute({kind:'clientAction',callbackId:forged})).status).toBe('invalid_state');expect((await sql.query('SELECT barber_id FROM drafts')).rows[0].barber_id).toBe(barber);
  await execute({kind:'clientAction',callbackId:old});expect((await sql.query('SELECT expires_at FROM drafts')).rows[0].expires_at.toISOString()).toBe('2026-11-06T04:30:00.000Z');
  const next=await button('Далее');expect((await execute({kind:'clientAction',callbackId:next},'100','2026-11-06T04:30:00.000Z')).status).toBe('stale_callback');
  const notice=(await sql.query("SELECT payload FROM outbox WHERE kind='start' AND chat_id=100 ORDER BY logical_key DESC LIMIT 1")).rows[0].payload.text;expect(notice).toContain('/start');
  await execute({kind:'start',payload:'b_invalid'});expect((await screen()).text).toContain('Ссылка мастера недоступна');expect((await screen()).text).not.toContain(token);
  const before=(await sql.query('SELECT version FROM drafts WHERE id=$1',[form.id])).rows[0].version;
  const base=db();const failing:Database={read:base.read,transaction:run=>base.transaction(tx=>run({...tx,query:async<T>(text:string,values:unknown[])=>{if(text.startsWith('INSERT INTO outbox')&&text.includes("'client_screen'"))throw Error('synthetic-screen-failure');return tx.query<T>(text,values);}}))};
  await expect(new Repository(failing).execute({telegramId:'100'},{kind:'start',payload:null},String(update++))).rejects.toThrow('synthetic-screen-failure');
  expect((await sql.query('SELECT version FROM drafts WHERE id=$1',[form.id])).rows[0].version).toBe(before);
},120000);
it('expired staff button refreshes only current authorized pending visit and role revocation cancels detail delivery',async()=>{
  await execute({kind:'start',payload:null});const user=(await sql.query('SELECT id FROM telegram_users WHERE telegram_id=100')).rows[0].id;const client=(await sql.query("UPDATE clients SET name='Тест',phone='+79123456789' WHERE user_id=$1 RETURNING id",[user])).rows[0].id;await sql.query("INSERT INTO phone_claims(client_id,user_id,phone,claimed_at) VALUES($1,$2,'+79123456789',$3)",[client,user,now]);
  const visit=await execute({kind:'requestBooking',barberId:barber,serviceIds:['00000000-0000-4000-8000-000000000003'],start:'2026-11-06T07:00:00.000Z'});expect(visit.status).toBe('pending');
  const old=(await sql.query("SELECT payload FROM outbox WHERE payload ? 'staffUserId' LIMIT 1")).rows[0].payload.buttons[0];
  const refreshedAt='2026-11-06T04:31:00.000Z',revokedAt='2026-11-06T04:32:00.000Z';
  const result=await execute({kind:'clientAction',callbackId:old},'200',refreshedAt);expect(result.status).toBe('stale_callback');expect((await sql.query('SELECT status,version FROM visits WHERE id=$1',[visit.entityId])).rows[0]).toEqual({status:'pending',version:1});
  expect((await sql.query('SELECT * FROM staff_callbacks WHERE visit_id=$1',[visit.entityId])).rows).toHaveLength(4);
  await sql.query("DELETE FROM roles WHERE user_id=(SELECT id FROM telegram_users WHERE telegram_id=200) AND role='barber'");
  expect((await execute({kind:'clientAction',callbackId:old},'200',revokedAt)).status).toBe('forbidden');
  const deliveries:Delivery[]=[];for(let i=0;i<2;i++)await new Outbox(db(revokedAt),{send:async d=>{deliveries.push(d);return {messageId:'1'};}}).deliver(revokedAt,5);
  const refusals=deliveries.filter(d=>d.chatId==='200');expect(refusals).toHaveLength(1);
  expect(refusals[0].payload).toEqual({text:'Заявка недоступна.'});
  expect(JSON.stringify(refusals)).not.toContain('+79123456789');expect(JSON.stringify(refusals)).not.toContain('Тест');
  expect((await sql.query("SELECT status FROM outbox WHERE payload ? 'staffUserId'")).rows).toEqual([{status:'cancelled'},{status:'cancelled'}]);
},120000);
it.each(['success','transient'] as const)('new start cancels an in-flight screen and fences late %s',async outcome=>{
  await execute({kind:'start',payload:null});const old=(await sql.query("SELECT id FROM outbox WHERE kind='client_screen' AND status='pending'")).rows[0].id;
  let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{entered=r;}),released=new Promise<void>(r=>{release=r;});
  const sending=new Outbox(db(),{send:async()=>{entered();await released;if(outcome==='transient')throw new DeliveryError('transient');return {messageId:'late'};}}).deliver(now,1);
  await reached;await execute({kind:'start',payload:null});release();await sending;
  expect((await sql.query('SELECT status,claim_token,message_id FROM outbox WHERE id=$1',[old])).rows[0]).toEqual({status:'cancelled',claim_token:null,message_id:null});
  const deliveries:Delivery[]=[];await new Outbox(db(),{send:async d=>{deliveries.push(d);return {messageId:'fresh'};}}).deliver(now,5);expect(deliveries).toHaveLength(1);
},120000);
