import pg from 'pg';
import {beforeAll,beforeEach,afterAll,expect,it,vi} from 'vitest';
import type {Update} from 'grammy/types';
import {testDatabaseUrl} from './safety';
import {migrate} from '../../scripts/migrate';
import {seed} from '../../scripts/seed';
import {nodeDatabase} from '../../scripts/node-db';
import {Repository} from '../../src/db/repository';
import {createBot} from '../../src/bot/create-bot';
import {Outbox} from '../../src/notifications/outbox';
import {hashToken} from '../../src/identity/service';
import {getReport} from '../../src/reports/service';
import {redeliverOnceOnLockTimeout} from './redelivery';
import type {Env} from '../../src/env';
import type {Database} from '../../src/db/client';
import type {Command,CommandResult} from '../../src/domain/types';
import type {Delivery} from '../../src/notifications/transport';
// Only own synthetic schema; the parent executes this against the isolated TEST_DATABASE_URL.
const schema=`stage11_accept_${crypto.randomUUID().replaceAll('-','')}`,scoped=new URL(testDatabaseUrl());scoped.searchParams.set('options',`-c search_path=${schema}`);
const b='00000000-0000-4000-8000-000000000002',s='00000000-0000-4000-8000-000000000003',s2='00000000-0000-4000-8000-000000000011',rank='00000000-0000-4000-8000-000000000001';
const initial='2026-11-06T04:00:00.000Z',personal='synthetic-personal-master-token-00000000000000';
let clock=initial,sql:pg.Client,created=false,sequence=110000,tables:string[]=[];
const database=():Database=>{const base=nodeDatabase(scoped.toString());return {read:base.read,transaction:run=>base.transaction(tx=>run({...tx,now:clock}))};};
const repository=()=>new Repository(database(),'300');
const snapshot=async()=> (await sql.query(`SELECT jsonb_build_object(${tables.map(t=>`'${t}',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM "${schema}"."${t}" t)`).join(',')}) AS state`)).rows[0].state;
const inventory:string[]=[];
async function replayCommand(label:string,actor:string,command:Command,id=String(sequence++)){
 const result=await repository().execute({telegramId:actor},command,id),before=await snapshot();
 expect(await repository().execute({telegramId:actor},command,id),label+' returned replay').toEqual(result);
 expect(await snapshot(),label+' exact replay changed persisted rows').toEqual(before);inventory.push(label);return result;
}
beforeAll(async()=>{sql=new pg.Client({connectionString:scoped.toString(),connectionTimeoutMillis:5000});await sql.connect();await sql.query(`CREATE SCHEMA "${schema}"`);created=true;await migrate(scoped.toString());await seed(scoped.toString());tables=(await sql.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',[schema])).rows.map(r=>r.tablename);});
afterAll(async()=>{if(created)await sql.query(`DROP SCHEMA "${schema}" CASCADE`);await sql?.end();});
beforeEach(async()=>{
 clock=initial;inventory.length=0;
 await sql.query('TRUNCATE telegram_users,clients,visits,barbers,ranks,services,outbox,jobs CASCADE');await seed(scoped.toString());
 await sql.query('UPDATE rank_tariffs SET price_kopecks=150000,duration_minutes=40');
 await sql.query("INSERT INTO services(id,name) VALUES($1,'Вторая синтетическая услуга')",[s2]);
 await sql.query('INSERT INTO assignments(barber_id,service_id) VALUES($1,$2)',[b,s2]);
 await sql.query('INSERT INTO rank_tariffs(rank_id,service_id,price_kopecks,duration_minutes) VALUES($1,$2,80000,35)',[rank,s2]);
 for(let day=1;day<=7;day++)await sql.query('INSERT INTO weekly_hours(barber_id,weekday,start_minute,end_minute) VALUES($1,$2,0,1200)',[b,day]);
 for(const [id,role] of [['100','client'],['101','client'],['200','barber'],['300','admin']]){
  const uid=(await sql.query('INSERT INTO telegram_users(telegram_id,last_seen_at) VALUES($1,$2) RETURNING id',[id,clock])).rows[0].id;
  await sql.query('INSERT INTO roles(user_id,role) VALUES($1,$2)',[uid,role]);
  if(id==='200')await sql.query('UPDATE barbers SET user_id=$1,public_token_hash=$2 WHERE id=$3',[uid,await hashToken(personal),b]);
  if(id==='100'||id==='101'){
   const phone=id==='100'?'+79123456100':'+79123456101';
   const cid=(await sql.query("INSERT INTO clients(user_id,name,phone) VALUES($1,'Synthetic', $2) RETURNING id",[uid,phone])).rows[0].id;
   await sql.query('INSERT INTO phone_claims(client_id,user_id,phone,claimed_at) VALUES($1,$2,$3,$4)',[cid,uid,phone,clock]);
  }
 }
});
it('real bot routing, PG, outbox and three roles retain snapshots and exactly replay every traversed mutating update',async()=>{
 await sql.query('DELETE FROM phone_claims WHERE user_id=(SELECT id FROM telegram_users WHERE telegram_id=100)');
 await sql.query("UPDATE clients SET name='',phone=NULL WHERE user_id=(SELECT id FROM telegram_users WHERE telegram_id=100)");
 const repo=repository(),observed=vi.spyOn(repo,'execute'),wakes:unknown[]=[],deliveries:Delivery[]=[];
 const env={BOT_TOKEN:'123456:synthetic',BOT_INFO:JSON.stringify({id:123456,is_bot:true,first_name:'Synthetic',username:'synthetic_bot'}),SCHEDULER:{idFromName:()=>({}),get:()=>({fetch:async(_url:unknown,init:RequestInit)=>{wakes.push(JSON.parse(String(init.body)));return Response.json({ok:true});}})}} as unknown as Env;
 const bot=createBot(env,repo);bot.api.config.use(async(_previous,method)=>{expect(method).toBe('answerCallbackQuery');return {ok:true,result:true} as never;});
 const actor=(id:string)=>({id:Number(id),is_bot:false as const,first_name:'Synthetic'});
 const text=(id:string,value:string):Update=>({update_id:sequence++,message:{message_id:sequence,date:1,chat:{id:Number(id),type:'private',first_name:'Synthetic'},from:actor(id),text:value,...(value.startsWith('/start')?{entities:[{type:'bot_command',offset:0,length:6} as const]}:{})}});
 const callback=(id:string,data:string):Update=>({update_id:sequence++,callback_query:{id:String(sequence),from:actor(id),chat_instance:'synthetic',data,message:{message_id:1,date:1,chat:{id:Number(id),type:'private',first_name:'Synthetic'}}}});
 async function apply(label:string,update:Update){
  await bot.handleUpdate(update);const result=await observed.mock.results.at(-1)!.value as CommandResult,before=await snapshot();
  await bot.handleUpdate(update);expect(await observed.mock.results.at(-1)!.value,label+' returned result').toEqual(result);expect(await snapshot(),label+' exact update replay').toEqual(before);inventory.push(label);return result;
 }
 async function button(id:string,kind:string,fields:Record<string,unknown>={}){
  const rows=(await sql.query(`SELECT c.id,c.action FROM callbacks c JOIN drafts d ON d.id=c.draft_id JOIN telegram_users u ON u.id=c.user_id WHERE u.telegram_id=$1 AND c.draft_version=d.version AND c.action->>'kind'=$2`,[id,kind])).rows;
  const chosen=rows.find(r=>Object.entries(fields).every(([key,value])=>r.action[key]===value));expect(chosen,kind+JSON.stringify(rows)).toBeTruthy();return chosen.id as string;
 }
 const click=async(label:string,kind:string,fields:Record<string,unknown>={},id='100')=>apply(label,callback(id,await button(id,kind,fields)));
 await apply('admin general entry',text('300','/start'));await apply('barber general entry',text('200','/start'));await apply('client general entry',text('100','/start'));
 await apply('client personal entry',text('100',`/start b_${personal}`));
 await click('select service one','service',{id:s});await click('select service two','service',{id:s2});await click('open exact month','calendar');
 const dates=(await sql.query("SELECT count(*)::integer n FROM callbacks c JOIN drafts d ON d.id=c.draft_id JOIN telegram_users u ON u.id=c.user_id WHERE u.telegram_id=100 AND c.draft_version=d.version AND c.action->>'kind'='day'")).rows[0].n;expect(dates).toBeLessThanOrEqual(31);
 await click('select day','day',{day:'2026-11-06'});await click('select 75-minute start','time',{start:'2026-11-06T07:00:00.000Z'});
 await apply('client name input',text('100','Synthetic client'));
 expect((await apply('foreign contact refusal',{update_id:sequence++,message:{message_id:sequence,date:1,chat:{id:100,type:'private',first_name:'Synthetic'},from:actor('100'),contact:{first_name:'Synthetic',phone_number:'+79123456101',user_id:101}}})).status).toBe('invalid_contact');
 // Own contact uses the actual createBot contact route and resumes the durable summary.
 await apply('own contact', {update_id:sequence++,message:{message_id:sequence,date:1,chat:{id:100,type:'private',first_name:'Synthetic'},from:actor('100'),contact:{first_name:'Synthetic',phone_number:'+79123456100',user_id:100}}});
 const request=await click('submit reviewed booking','submit');expect(request.status).toBe('pending');const visit=request.entityId!;
 const items=(await sql.query('SELECT * FROM visit_items WHERE visit_id=$1 ORDER BY service_id',[visit])).rows;expect(items.map(i=>i.duration_minutes).sort()).toEqual([35,40]);
 const outbox=new Outbox(database(),{send:async delivery=>{deliveries.push(delivery);return {messageId:String(deliveries.length)};}});for(let n=0;n<5;n++)await outbox.deliver(clock,5);
 const staff=deliveries.find(d=>d.chatId==='200'&&(d.payload as any).reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data&&(d.payload as any).text.includes('Synthetic'));
 expect(staff).toBeTruthy();const decision=(staff!.payload as any).reply_markup.inline_keyboard[0][0].callback_data;
 expect((await apply('foreign decision refusal',callback('101',decision))).status).toBe('forbidden');
 expect((await apply('barber independent confirmation',callback('200',decision))).status).toBe('confirmed');
 await replayCommand('admin future tariff','300',{kind:'setRankTariff',rankId:rank,serviceId:s,expectedVersion:1,priceKopecks:999,durationMinutes:30});
 expect((await sql.query('SELECT * FROM visit_items WHERE visit_id=$1 ORDER BY service_id',[visit])).rows).toEqual(items);
 const transfer=await replayCommand('client transfer request','100',{kind:'requestTransfer',visitId:visit,expectedVersion:2,newStart:'2026-11-06T09:00:00.000Z'});expect(transfer.status).toBe('pending');
 expect((await replayCommand('barber transfer consent','200',{kind:'decideTransfer',transferId:transfer.entityId!,expectedVersion:1,accept:true})).status).toBe('accepted');
 const proposal=await replayCommand('staff transfer proposal','200',{kind:'proposeTransfer',visitId:visit,expectedVersion:3,newStart:'2026-11-06T11:00:00.000Z',reason:'Synthetic time change'});expect(proposal.status).toBe('pending');
 expect((await replayCommand('client transfer consent','100',{kind:'decideTransfer',transferId:proposal.entityId!,expectedVersion:1,accept:true})).status).toBe('accepted');
 const conflict=await replayCommand('admin schedule conflict','300',{kind:'saveDateException',barberId:b,expectedVersion:1,date:'2026-11-06',intervals:[]});expect(conflict.status).toBe('schedule_conflict');
 const manual=await replayCommand('barber phone booking','200',{kind:'createManualBooking',barberId:b,clientName:'Synthetic phone',phone:'+79123456102',serviceIds:[s2],start:'2026-11-06T14:00:00.000Z'});expect(manual.status).toBe('confirmed');
 const phone=await replayCommand('staff phone proposal','200',{kind:'proposeTransfer',visitId:manual.entityId!,expectedVersion:1,newStart:'2026-11-06T15:00:00.000Z',reason:'Synthetic phone agreement'});expect(phone.status).toBe('pending');
 expect((await replayCommand('staff records phone agreement','200',{kind:'recordPhoneAgreement',transferId:phone.entityId!,expectedVersion:1})).status).toBe('accepted');
 expect((await replayCommand('staff phone cancellation','200',{kind:'staffCancelBooking',visitId:manual.entityId!,expectedVersion:2,reason:'Synthetic cancellation'})).status).toBe('cancelled');
 const expiring=await replayCommand('second client expiring request','101',{kind:'requestBooking',barberId:b,serviceIds:[s2],start:'2026-11-06T16:00:00.000Z'});expect(expiring.status).toBe('pending');
 clock='2026-11-06T05:00:00.000Z';const expiredRepo=repository();await expiredRepo.drainDue(clock,5);expect((await sql.query('SELECT status FROM visits WHERE id=$1',[expiring.entityId])).rows[0].status).toBe('expired');const expiredState=await snapshot();await expiredRepo.drainDue(clock,5);expect(await snapshot()).toEqual(expiredState);
 clock='2026-11-06T09:00:00.000Z';const reminded:Delivery[]=[];for(let n=0;n<8;n++)await new Outbox(database(),{send:async d=>{reminded.push(d);return {messageId:'synthetic'};}}).deliver(clock,5);expect(reminded.some(d=>d.entityId===visit&&(d.payload as any).text?.includes('Напомина'))).toBe(true);
 clock='2026-11-06T11:00:00.000Z';expect((await replayCommand('barber outcome','200',{kind:'markOutcome',visitId:visit,expectedVersion:4,outcome:'completed'})).status).toBe('completed');
 expect(await getReport({telegramId:'200'},{fromLocalDate:'2026-11-06',toLocalDate:'2026-11-06'},database())).toEqual({completed:1,noShows:0,serviceValueKopecks:230000});
 expect((await replayCommand('admin audited correction','300',{kind:'correctOutcome',visitId:visit,expectedVersion:5,outcome:'no_show',reason:'Synthetic correction'})).status).toBe('no_show');
 expect(await getReport({telegramId:'300'},{fromLocalDate:'2026-11-06',toLocalDate:'2026-11-06'},database())).toEqual({completed:0,noShows:1,serviceValueKopecks:0});
 expect(wakes.length).toBeGreaterThan(0);expect(inventory).toHaveLength(28);observed.mockRestore();
},300000);
const request=(start:string):Command=>({kind:'requestBooking',barberId:b,serviceIds:[s2],start});
async function confirmed(actor:string,start:string,prefix:string){const v=await replayCommand(prefix+' request',actor,request(start));expect(v.status).toBe('pending');expect((await replayCommand(prefix+' confirm','200',{kind:'confirmBooking',visitId:v.entityId!,expectedVersion:1})).status).toBe('confirmed');return v.entityId!;}
async function race(events:Array<{label:string;actor:string;command:Command}>){
 const ids=events.map(()=>String(sequence++));
 // Every execute creates a new nodeDatabase/client; shop-lock contention is genuine PostgreSQL.
 const results=await Promise.all(events.map((e,i)=>redeliverOnceOnLockTimeout(()=>repository().execute({telegramId:e.actor},e.command,ids[i]))));
 const before=await snapshot();for(let i=0;i<events.length;i++){expect(await repository().execute({telegramId:events[i].actor},events[i].command,ids[i])).toEqual(results[i]);expect(await snapshot()).toEqual(before);inventory.push(events[i].label);}return results;
}
it('independent concurrent proposal/proposal transactions have one winner and preserve both old visits',async()=>{
 const first=await confirmed('100','2026-11-06T07:00:00.000Z','first'),second=await confirmed('101','2026-11-06T08:00:00.000Z','second');
 const proposals=[first,second].map((visitId,i)=>({label:`proposal ${i+1}`,actor:'200',command:{kind:'proposeTransfer',visitId,expectedVersion:2,newStart:'2026-11-06T10:00:00.000Z',reason:'Synthetic collision'} as Command}));
 const results=await race(proposals);expect(results.filter(r=>r.status==='pending')).toHaveLength(1);expect(results.filter(r=>r.status==='slot_unavailable')).toHaveLength(1);
 expect((await sql.query("SELECT id,status,version,start_at FROM visits ORDER BY start_at")).rows).toEqual([{id:first,status:'confirmed',version:2,start_at:new Date('2026-11-06T07:00:00Z')},{id:second,status:'confirmed',version:2,start_at:new Date('2026-11-06T08:00:00Z')}]);
 expect((await sql.query("SELECT * FROM transfers WHERE status='pending'")).rows).toHaveLength(1);expect((await sql.query("SELECT * FROM holds WHERE kind='transfer'")).rows).toHaveLength(1);expect((await sql.query("SELECT * FROM jobs WHERE kind='expire_transfer' AND status='pending'")).rows).toHaveLength(1);
},120000);
it('independent proposal/competing-request transactions hold one candidate and retain the confirmed old interval',async()=>{
 const visit=await confirmed('100','2026-11-06T07:00:00.000Z','old');
 const results=await race([{label:'staff proposal winner or refusal',actor:'200',command:{kind:'proposeTransfer',visitId:visit,expectedVersion:2,newStart:'2026-11-06T10:00:00.000Z',reason:'Synthetic collision'}},{label:'competing request winner or refusal',actor:'101',command:request('2026-11-06T10:00:00.000Z')}]);
 expect(results.filter(r=>r.status==='pending')).toHaveLength(1);expect(results.filter(r=>r.status==='slot_unavailable')).toHaveLength(1);
 expect((await sql.query('SELECT status,version,schedule_generation,start_at FROM visits WHERE id=$1',[visit])).rows[0]).toEqual({status:'confirmed',version:2,schedule_generation:1,start_at:new Date('2026-11-06T07:00:00Z')});
 expect((await sql.query("SELECT * FROM holds WHERE start_at='2026-11-06T10:00:00Z'")).rows).toHaveLength(1);
},120000);
