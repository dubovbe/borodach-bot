import pg from 'pg';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {testDatabaseUrl} from './safety';
import {migrate} from '../../scripts/migrate';
import {seed} from '../../scripts/seed';
import {nodeDatabase} from '../../scripts/node-db';
import {Repository} from '../../src/db/repository';
import {executeBooking,type Context} from '../../src/booking/service';
import {prepareAvailability} from '../../src/schedule/service';
import type {Command,CommandResult} from '../../src/domain/types';
import type {Database} from '../../src/db/client';

const schema=`review6_${crypto.randomUUID().replaceAll('-','')}`;
const scoped=new URL(testDatabaseUrl());scoped.searchParams.set('options',`-c search_path=${schema}`);
const now='2026-11-06T04:00:00.000Z',barber='00000000-0000-4000-8000-000000000002',service='00000000-0000-4000-8000-000000000003';
let sql:pg.Client,created=false,update=76000;
const db=():Database=>{const base=nodeDatabase(scoped.toString());return {read:base.read,transaction:run=>base.transaction(tx=>run({...tx,now}))};};
const request=():Extract<Command,{kind:'requestBooking'}>=>({kind:'requestBooking',barberId:barber,serviceIds:[service],start:'2026-11-06T07:00:00.000Z'});
const execute=(command:Command)=>new Repository(db()).execute({telegramId:'100'},command,String(update++));
const userId=async(id:string)=>(await sql.query('SELECT id FROM telegram_users WHERE telegram_id=$1',[id])).rows[0].id as string;
const screen=async()=>(await sql.query("SELECT payload FROM outbox WHERE kind='client_screen' AND status='pending' AND chat_id=100")).rows[0]?.payload;
async function button(label:string){const s=await screen();const b=s?.reply_markup?.inline_keyboard.flat().find((b:any)=>label==='6'?b.text==='6':b.text.includes(label));expect(b,JSON.stringify(s)).toBeTruthy();return b.callback_data as string;}
async function click(label:string){const callbackId=await button(label);return {callbackId,result:await execute({kind:'clientAction',callbackId})};}
const overlaps=async()=>(await sql.query("SELECT a.id FROM visits a JOIN visits b ON a.id<b.id AND a.barber_id=b.barber_id AND a.start_at<b.end_at AND b.start_at<a.end_at WHERE a.status IN ('pending','confirmed') AND b.status IN ('pending','confirmed')")).rows;
// Legacy third-argument attack is deliberate runtime input, independent of the eventual narrowed TS API.
const legacyPreparedCall=executeBooking as unknown as (c:Context,command:ReturnType<typeof request>,legacy:unknown)=>Promise<CommandResult>;
beforeAll(async()=>{sql=new pg.Client({connectionString:scoped.toString(),connectionTimeoutMillis:5000});await sql.connect();await sql.query(`CREATE SCHEMA "${schema}"`);created=true;await migrate(scoped.toString());await seed(scoped.toString());});
afterAll(async()=>{if(created)await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await sql?.end();});
beforeEach(async()=>{
  await sql.query('TRUNCATE outbox,jobs,telegram_users,clients,visits,barbers CASCADE');await seed(scoped.toString());await sql.query('UPDATE rank_tariffs SET price_kopecks=160000');
  for(let day=1;day<=7;day++)await sql.query('INSERT INTO weekly_hours(barber_id,weekday,start_minute,end_minute) VALUES($1,$2,0,1200)',[barber,day]);
  for(const id of ['100','101','102']){const uid=(await sql.query('INSERT INTO telegram_users(telegram_id,last_seen_at) VALUES($1,$2) RETURNING id',[id,now])).rows[0].id;await sql.query("INSERT INTO roles(user_id,role) VALUES($1,'client')",[uid]);const phone=`+79123456${id}`;const cid=(await sql.query("INSERT INTO clients(user_id,name,phone) VALUES($1,'Тестовый Клиент',$2) RETURNING id",[uid,phone])).rows[0].id;await sql.query('INSERT INTO phone_claims(client_id,user_id,phone,claimed_at) VALUES($1,$2,$3,$4)',[cid,uid,phone,now]);}
});
it.each([['onboarding',true],['onboarding',false],['stale-refresh',true],['stale-refresh',false]] as const)('I1 %s binds last displayed 1500, price reverts: %s',async(path,reverts)=>{
  if(path==='onboarding'){await sql.query("DELETE FROM phone_claims WHERE user_id=(SELECT id FROM telegram_users WHERE telegram_id=100)");await sql.query("UPDATE clients SET name='',phone=NULL WHERE user_id=(SELECT id FROM telegram_users WHERE telegram_id=100)");}
  await execute({kind:'start',payload:null});await click('Вымышленный мастер');await click('Тестовая стрижка');await click('Далее');await click('6');const time=await click('10:00');
  await sql.query('UPDATE rank_tariffs SET price_kopecks=150000');
  if(path==='onboarding'){await execute({kind:'saveDraftInput',text:'Тестовый Клиент'});await execute({kind:'updateContact',contact:{userId:'100',phone:'+79123456789'}});}else await execute({kind:'clientAction',callbackId:time.callbackId});
  expect((await screen()).text).toContain('1500 ₽');const submit=await button('Отправить');
  const saved=(await sql.query('SELECT d.state,d.version,c.draft_version FROM drafts d JOIN callbacks c ON c.draft_id=d.id WHERE c.id=$1',[submit])).rows[0];
  expect(JSON.parse(saved.state.quote).items[0].priceKopecks).toBe(150000);expect(saved.draft_version).toBe(saved.version);
  if(reverts)await sql.query('UPDATE rank_tariffs SET price_kopecks=160000');
  expect((await execute({kind:'clientAction',callbackId:submit})).status).toBe(reverts?'quote_conflict':'pending');
  if(reverts)expect((await sql.query('SELECT * FROM visits')).rows).toHaveLength(0);
  else expect((await sql.query('SELECT price_kopecks FROM visit_items')).rows).toEqual([{price_kopecks:150000}]);
},120000);
it('I2 caller cannot exclude another clients confirmed visit through supplied prepared availability',async()=>{
  const victim=(await sql.query("INSERT INTO visits(client_id,barber_id,status,start_at,end_at,created_at) SELECT c.id,$1,'confirmed',$2,$2::timestamptz+interval '45 minutes',$3 FROM clients c JOIN telegram_users u ON u.id=c.user_id WHERE u.telegram_id=102 RETURNING id",[barber,request().start,now])).rows[0].id;
  const uid=await userId('100');let accepted=false;
  await db().transaction(async tx=>{const prepared=await prepareAvailability({barberId:barber,serviceIds:[service],from:request().start,to:request().start,actorMode:'client',excludeVisitId:victim},tx);try{accepted=(await legacyPreparedCall({tx,userId:uid,updateId:String(update++)},request(),prepared)).status==='pending';}catch(error){expect(error).toBeInstanceOf(Error);}});
  expect(accepted).toBe(false);expect(await overlaps()).toHaveLength(0);expect((await sql.query('SELECT * FROM visits')).rows).toHaveLength(1);
},120000);
it('I2 cached preparation cannot hide first hold from a second request in the same transaction',async()=>{
  const first=await userId('100'),second=await userId('101');let secondAccepted=false;
  await db().transaction(async tx=>{
    const prepared=await prepareAvailability({barberId:barber,serviceIds:[service],from:request().start,to:request().start,actorMode:'client'},tx);
    expect((await executeBooking({tx,userId:first,updateId:String(update++)},request())).status).toBe('pending');
    try{secondAccepted=(await legacyPreparedCall({tx,userId:second,updateId:String(update++)},request(),prepared)).status==='pending';}catch(error){expect(error).toBeInstanceOf(Error);}
  });
  expect(secondAccepted).toBe(false);expect(await overlaps()).toHaveLength(0);expect((await sql.query('SELECT * FROM visits')).rows).toHaveLength(1);
},120000);
