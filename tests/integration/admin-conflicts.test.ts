import pg from 'pg';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {testDatabaseUrl} from './safety';
import {migrate} from '../../scripts/migrate';
import {seed} from '../../scripts/seed';
import {nodeDatabase} from '../../scripts/node-db';
import {Repository} from '../../src/db/repository';
import {hashToken,publicBookingToken,renderPublicLink} from '../../src/identity/service';
import {redeliverOnceOnLockTimeout} from './redelivery';
import {effectiveOffer} from '../../src/catalog/service';
import type {Command,CommandResult,Conflict} from '../../src/domain/types';
const schema=`stage9_${crypto.randomUUID().replaceAll('-','')}`;
const scoped=new URL(testDatabaseUrl());scoped.searchParams.set('options',`-c search_path=${schema}`);
const b='00000000-0000-4000-8000-000000000002',s='00000000-0000-4000-8000-000000000003',rank='00000000-0000-4000-8000-000000000001';
const now='2026-11-06T04:00:00.000Z';
let sql:pg.Client,created=false,update=9000;
const base=nodeDatabase(scoped.toString());
const database={read:base.read,transaction:<T>(run:(tx:import('../../src/db/client').Tx)=>Promise<T>)=>base.transaction(tx=>run({...tx,now}))};
const repository=new Repository(database);
const execute=(actor:string,command:Command)=>repository.execute({telegramId:actor},command,String(update++));
beforeAll(async()=>{sql=new pg.Client({connectionString:scoped.toString(),connectionTimeoutMillis:5000});await sql.connect();await sql.query(`CREATE SCHEMA "${schema}"`);created=true;await migrate(scoped.toString());await seed(scoped.toString());});
afterAll(async()=>{if(created)await sql.query(`DROP SCHEMA "${schema}" CASCADE`);await sql?.end();});
beforeEach(async()=>{
 await sql.query('TRUNCATE telegram_users,visits,weekly_hours,date_exceptions,outbox,jobs,barbers,ranks,services CASCADE');await seed(scoped.toString());
 await sql.query('UPDATE barbers SET version=1,archived_at=NULL');await sql.query('UPDATE ranks SET version=1,archived_at=NULL');await sql.query('UPDATE services SET version=1,archived_at=NULL');await sql.query('UPDATE rank_tariffs SET price_kopecks=150000,duration_minutes=45');
 for(const [id,role] of [['100','client'],['200','barber'],['201','admin']]){
 const uid=(await sql.query('INSERT INTO telegram_users(telegram_id,last_seen_at) VALUES($1,$2) RETURNING id',[id,now])).rows[0].id;
 await sql.query('INSERT INTO roles(user_id,role) VALUES($1,$2)',[uid,role]);
 if(id==='100'){const client=(await sql.query("INSERT INTO clients(user_id,name,phone) VALUES($1,'Test','+79123456789') RETURNING id",[uid])).rows[0].id;await sql.query("INSERT INTO phone_claims(client_id,user_id,phone,claimed_at) VALUES($1,$2,'+79123456789',$3)",[client,uid,now]);}
 if(id==='200')await sql.query('UPDATE barbers SET user_id=$1 WHERE id=$2',[uid,b]);
 }
 await sql.query('INSERT INTO weekly_hours(barber_id,weekday,start_minute,end_minute) SELECT $1,n,0,1440 FROM generate_series(1,7) n',[b]);
});
async function confirmed(){const v=await execute('100',{kind:'requestBooking',barberId:b,serviceIds:[s],start:'2026-11-06T07:00:00.000Z'});expect(v.status).toBe('pending');expect((await execute('200',{kind:'confirmBooking',visitId:v.entityId!,expectedVersion:1})).status).toBe('confirmed');return v.entityId!;}
it('admin tariff changes future quotes while preserving booked snapshots',async()=>{
 const visit=await confirmed(),before=(await sql.query('SELECT * FROM visit_items WHERE visit_id=$1',[visit])).rows;
 expect((await execute('100',{kind:'setRankTariff',rankId:rank,serviceId:s,expectedVersion:1,priceKopecks:230001,durationMinutes:75})).status).toBe('forbidden');
 expect((await execute('201',{kind:'setRankTariff',rankId:rank,serviceId:s,expectedVersion:1,priceKopecks:230001,durationMinutes:75})).status).toBe('saved');
 const offer=await database.transaction(tx=>effectiveOffer(b,[s],tx));expect(offer.items[0]).toMatchObject({priceKopecks:230001,durationMinutes:75});
 expect((await sql.query('SELECT * FROM visit_items WHERE visit_id=$1',[visit])).rows).toEqual(before);
});
it('admin day off reports both live visit and transfer without changing schedule',async()=>{
 const visit=await confirmed();expect((await execute('100',{kind:'requestTransfer',visitId:visit,expectedVersion:2,newStart:'2026-11-06T10:00:00.000Z'})).status).toBe('pending');
 const before=(await sql.query('SELECT * FROM weekly_hours ORDER BY id')).rows;
 const command:Command={kind:'saveDateException',barberId:b,expectedVersion:1,date:'2026-11-06',intervals:[]};
 const denied=await execute('100',command);expect(denied.status).toBe('forbidden');expect((denied as CommandResult&{conflicts?:Conflict[]}).conflicts).toBeUndefined();
 const result=await execute('201',command) as CommandResult&{conflicts?:Conflict[]};expect(result.status).toBe('schedule_conflict');expect((await sql.query("SELECT kind FROM audit_events WHERE kind='schedule_changed'")).rows).toHaveLength(0);expect((await sql.query("SELECT payload FROM outbox WHERE logical_key LIKE 'admin-conflict:%'")).rows).toHaveLength(1);expect(result.conflicts).toEqual([{visitId:visit,kind:'visit',start:'2026-11-06T07:00:00.000Z',end:'2026-11-06T07:45:00.000Z'},{visitId:visit,kind:'transfer',start:'2026-11-06T10:00:00.000Z',end:'2026-11-06T10:45:00.000Z'}]);
 expect((await sql.query('SELECT * FROM weekly_hours ORDER BY id')).rows).toEqual(before);expect((await sql.query('SELECT * FROM date_exceptions')).rows).toHaveLength(0);expect((await sql.query('SELECT version FROM barbers WHERE id=$1',[b])).rows[0].version).toBe(1);
});
it('admin archive blocks future confirmed barber and preserves ownership',async()=>{
 await confirmed();const result=await execute('201',{kind:'archiveBarber',barberId:b,expectedVersion:1});expect(result.status).toBe('barber_conflict');expect((await sql.query('SELECT archived_at,user_id IS NOT NULL AS linked,version FROM barbers WHERE id=$1',[b])).rows[0]).toEqual({archived_at:null,linked:true,version:1});
});
it('admin successful weekly and date writes preserve unrelated schedule data',async()=>{
 await sql.query("INSERT INTO date_exceptions(barber_id,local_date,intervals) VALUES($1,'2026-11-08','[]')",[b]);
 const originalException=(await sql.query('SELECT * FROM date_exceptions WHERE barber_id=$1',[b])).rows;
 expect((await execute('201',{kind:'saveWeeklyHours',barberId:b,expectedVersion:1,weekday:1,intervals:[{startMinute:540,endMinute:720},{startMinute:780,endMinute:1080}]})).status).toBe('schedule_changed');
 expect((await sql.query('SELECT weekday,start_minute,end_minute FROM weekly_hours WHERE barber_id=$1 AND weekday=1 ORDER BY start_minute',[b])).rows).toEqual([{weekday:1,start_minute:540,end_minute:720},{weekday:1,start_minute:780,end_minute:1080}]);
 expect((await sql.query('SELECT local_date::text,intervals FROM date_exceptions WHERE barber_id=$1',[b])).rows).toEqual([{local_date:'2026-11-08',intervals:[]}]);
 expect((await sql.query('SELECT * FROM date_exceptions WHERE barber_id=$1',[b])).rows).toEqual(originalException);
 const originalWeekly=(await sql.query('SELECT * FROM weekly_hours WHERE barber_id=$1 ORDER BY id',[b])).rows;
 expect((await execute('201',{kind:'saveDateException',barberId:b,expectedVersion:2,date:'2026-11-09',intervals:[]})).status).toBe('schedule_changed');
 expect((await sql.query('SELECT * FROM weekly_hours WHERE barber_id=$1 ORDER BY id',[b])).rows).toEqual(originalWeekly);
 expect((await sql.query('SELECT count(*)::int n FROM date_exceptions WHERE barber_id=$1',[b])).rows[0].n).toBe(2);
 expect((await execute('201',{kind:'saveDateException',barberId:b,expectedVersion:3,date:'2026-11-09',intervals:null})).status).toBe('schedule_changed');
 expect((await sql.query('SELECT local_date::text FROM date_exceptions WHERE barber_id=$1',[b])).rows).toEqual([{local_date:'2026-11-08'}]);
});

it('aggregate assignment and override fences prevent removal recreation ABA and expose rank fallback',async()=>{
 const snapshot=await database.transaction(tx=>effectiveOffer(b,[s],tx));expect(snapshot.priceKopecks).toBe(150000);
 expect((await execute('201',{kind:'setBarberTariff',operation:'set',barberId:b,serviceId:s,expectedVersion:1,priceKopecks:220000,durationMinutes:60})).status).toBe('saved');
 expect((await execute('201',{kind:'setBarberTariff',operation:'reset',barberId:b,serviceId:s,expectedVersion:2})).status).toBe('saved');
 expect((await database.transaction(tx=>effectiveOffer(b,[s],tx))).priceKopecks).toBe(150000);
 expect((await execute('201',{kind:'setBarberTariff',operation:'set',barberId:b,serviceId:s,expectedVersion:3,priceKopecks:0,durationMinutes:75})).status).toBe('saved');
 expect((await execute('201',{kind:'setBarberTariff',operation:'reset',barberId:b,serviceId:s,expectedVersion:2})).status).toBe('stale_version');
 expect((await execute('201',{kind:'assignBarberService',barberId:b,serviceId:s,expectedVersion:4,assigned:false})).status).toBe('saved');
 expect((await execute('201',{kind:'assignBarberService',barberId:b,serviceId:s,expectedVersion:5,assigned:true})).status).toBe('saved');
 expect((await execute('201',{kind:'assignBarberService',barberId:b,serviceId:s,expectedVersion:4,assigned:false})).status).toBe('stale_version');
 expect((await sql.query('SELECT * FROM barber_tariffs WHERE barber_id=$1',[b])).rows).toHaveLength(1);
 expect((await execute('201',{kind:'saveBarber',barberId:b,expectedVersion:6,name:'Rankless',rankId:null})).status).toBe('saved');
 expect((await database.transaction(tx=>effectiveOffer(b,[s],tx))).items[0]).toMatchObject({priceKopecks:0,durationMinutes:75});
});
it('unassign and service archive preserve booked snapshots and frozen transfer terms',async()=>{
 const visit=await confirmed(),before=(await sql.query('SELECT * FROM visit_items WHERE visit_id=$1',[visit])).rows;
 expect((await execute('201',{kind:'assignBarberService',barberId:b,serviceId:s,expectedVersion:1,assigned:false})).status).toBe('saved');
 expect((await execute('201',{kind:'archiveService',serviceId:s,expectedVersion:1})).status).toBe('saved');
 expect((await execute('100',{kind:'requestTransfer',visitId:visit,expectedVersion:2,newStart:'2026-11-06T10:00:00.000Z'})).status).toBe('pending');
 expect((await sql.query('SELECT * FROM visit_items WHERE visit_id=$1',[visit])).rows).toEqual(before);
 expect((await execute('201',{kind:'saveService',serviceId:s,expectedVersion:2,name:'No restore'})).status).toBe('not_found');
});
it('past confirmed and expired holds permit edits while ongoing full interval blocks both schedule APIs',async()=>{
 const visit=await confirmed();
 await sql.query("UPDATE visits SET start_at='2026-11-06T03:30Z',end_at='2026-11-06T04:30Z' WHERE id=$1",[visit]);
 await sql.query("UPDATE holds SET start_at='2026-11-06T03:30Z',end_at='2026-11-06T04:30Z' WHERE visit_id=$1",[visit]);
 const legacy:Command={kind:'changeSchedule',barberId:b,expectedVersion:1,schedule:{timezone:'Europe/Moscow',weekly:{},exceptions:{'2026-11-06':[{startMinute:420,endMinute:480}]}}};
 const conflict=await execute('201',legacy);expect(conflict.status).toBe('schedule_conflict');expect(conflict.conflicts).toEqual([{visitId:visit,kind:'visit',start:'2026-11-06T03:30:00.000Z',end:'2026-11-06T04:30:00.000Z'}]);
 expect((await execute('201',{kind:'saveDateException',barberId:b,expectedVersion:1,date:'2026-11-06',intervals:[]})).status).toBe('schedule_conflict');
 await sql.query("UPDATE visits SET end_at='2026-11-06T04:00Z' WHERE id=$1",[visit]);await sql.query("UPDATE holds SET end_at='2026-11-06T04:00Z' WHERE visit_id=$1",[visit]);
 await sql.query("INSERT INTO holds(visit_id,barber_id,kind,start_at,end_at,expires_at) VALUES($1,$2,'visit','2026-11-07T07:00Z','2026-11-07T08:00Z','2026-11-05T04:00Z')",[visit,b]);
 expect((await execute('201',{kind:'saveDateException',barberId:b,expectedVersion:1,date:'2026-11-06',intervals:[]})).status).toBe('schedule_changed');
 expect((await execute('201',{kind:'changeSchedule',barberId:b,expectedVersion:2,schedule:{timezone:'Europe/Moscow',weekly:{},exceptions:{}}})).status).toBe('schedule_changed');
});
it('barber archive invalidates open invite delivery while retaining user and cumulative roles',async()=>{
 const uid=(await sql.query('SELECT user_id FROM barbers WHERE id=$1',[b])).rows[0].user_id;
 await sql.query("INSERT INTO roles(user_id,role) VALUES($1,'client'),($1,'admin')",[uid]);
 const invite=(await sql.query("INSERT INTO invitations(barber_id,token_hash,expires_at,issued_by) VALUES($1,$2,'2026-11-07T04:00Z',$3) RETURNING id",[b,'a'.repeat(64),uid])).rows[0].id;
 await sql.query("INSERT INTO outbox(logical_key,update_id,kind,chat_id,payload,due_at) VALUES('synthetic-invite',1,'invitation',201,$1::jsonb,$2)",[JSON.stringify({invitationId:invite}),now]);
 expect((await execute('201',{kind:'archiveBarber',barberId:b,expectedVersion:1})).status).toBe('saved');
 expect((await sql.query('SELECT user_id,archived_at IS NOT NULL AS archived FROM barbers WHERE id=$1',[b])).rows[0]).toEqual({user_id:uid,archived:true});
 expect((await sql.query('SELECT role FROM roles WHERE user_id=$1 ORDER BY role',[uid])).rows.map(x=>x.role)).toEqual(['admin','barber','client']);
 expect((await sql.query('SELECT revoked_at IS NOT NULL AS revoked FROM invitations WHERE id=$1',[invite])).rows[0].revoked).toBe(true);expect((await sql.query("SELECT status FROM outbox WHERE logical_key='synthetic-invite'")).rows[0].status).toBe('cancelled');
 expect((await execute('201',{kind:'saveBarber',barberId:b,expectedVersion:2,name:'No restore',rankId:rank})).status).toBe('not_found');
});
it('rank archival refuses active references and concurrent versioned edits do not overwrite',async()=>{
 expect((await execute('201',{kind:'archiveRank',rankId:rank,expectedVersion:1})).status).toBe('rank_in_use');
 const results=await Promise.all(['Alpha','Beta'].map(name=>redeliverOnceOnLockTimeout(()=>execute('201',{kind:'saveService',serviceId:s,expectedVersion:1,name}))));
 expect(results.map(x=>x.status).sort()).toEqual(['saved','stale_version']);
 expect((await execute('201',{kind:'saveBarber',barberId:b,expectedVersion:1,name:'Individual',rankId:null})).status).toBe('saved');expect((await execute('201',{kind:'archiveRank',rankId:rank,expectedVersion:1})).status).toBe('saved');
 expect((await execute('201',{kind:'saveRank',rankId:rank,expectedVersion:2,name:'No restore'})).status).toBe('not_found');
});
it('horizon reduction preserves visits transfers and reminders and rejects out of bounds',async()=>{
 const visit=await confirmed();const transfer=await execute('100',{kind:'requestTransfer',visitId:visit,expectedVersion:2,newStart:'2026-11-06T10:00:00.000Z'});expect(transfer.status).toBe('pending');
 const before=(await sql.query('SELECT * FROM visits WHERE id=$1',[visit])).rows,holds=(await sql.query('SELECT * FROM holds WHERE visit_id=$1 ORDER BY id',[visit])).rows,jobs=(await sql.query('SELECT * FROM jobs ORDER BY id')).rows;
 for(const days of [0,366,1.5])expect((await execute('201',{kind:'setBookingHorizon',expectedVersion:1,days})).status).toBe('invalid_input');
 expect((await execute('201',{kind:'setBookingHorizon',expectedVersion:1,days:1})).status).toBe('saved');expect((await execute('201',{kind:'setBookingHorizon',expectedVersion:1,days:365})).status).toBe('stale_version');
 expect((await sql.query('SELECT * FROM visits WHERE id=$1',[visit])).rows).toEqual(before);expect((await sql.query('SELECT * FROM holds WHERE visit_id=$1 ORDER BY id',[visit])).rows).toEqual(holds);expect((await sql.query('SELECT * FROM jobs ORDER BY id')).rows).toEqual(jobs);
});
it('legacy public link show never replaces and explicit replacement stores only hash with stable managed show',async()=>{
 const secret='synthetic-Stage9-secret-0123456789-ABCDEFG',options={invitationSecret:secret,botUsername:'test_bot'};const r=new Repository(database,'',options);
 const run=(command:Command)=>r.execute({telegramId:'201'},command,String(update++));
 await sql.query('UPDATE barbers SET public_token_hash=$2 WHERE id=$1',[b,'b'.repeat(64)]);
 expect((await run({kind:'showPublicLink',barberId:b,expectedVersion:1})).status).toBe('public_link_legacy');expect((await sql.query('SELECT public_token_hash FROM barbers WHERE id=$1',[b])).rows[0].public_token_hash).toBe('b'.repeat(64));
 expect((await run({kind:'issuePublicLink',barberId:b,expectedVersion:1,replace:false})).status).toBe('public_link_legacy');
 expect((await run({kind:'issuePublicLink',barberId:b,expectedVersion:1,replace:true})).status).toBe('saved');const token=await publicBookingToken(b,secret);expect((await sql.query('SELECT public_token_hash FROM barbers WHERE id=$1',[b])).rows[0].public_token_hash).toBe(await hashToken(token));
 expect((await run({kind:'showPublicLink',barberId:b,expectedVersion:2})).status).toBe('saved');expect((await sql.query('SELECT version FROM barbers WHERE id=$1',[b])).rows[0].version).toBe(2);
 expect(await database.transaction(tx=>renderPublicLink(tx,b,'201',options))).toContain('?start=b_'+token);expect(await database.transaction(tx=>renderPublicLink(tx,b,'100',options))).toBeNull();
 const metadata=(await sql.query("SELECT payload::text AS data FROM outbox UNION ALL SELECT result::text FROM processed_updates UNION ALL SELECT data::text FROM audit_events")).rows.map(x=>x.data).join('');expect(metadata).not.toContain(token);expect(metadata).not.toContain('https://');
});
it('admin real SQL wizard reviews service creation and saves once through opaque callback routing',async()=>{
 const run=(command:Command)=>execute('201',command);
 const current=async()=>{const row=(await sql.query("SELECT payload FROM outbox WHERE kind='client_screen' AND chat_id=201 AND status='pending' ORDER BY due_at,id LIMIT 1")).rows[0];expect(row).toBeDefined();return row.payload;};
 const click=async(label:string)=>{const screen=await current(),button=screen.reply_markup.inline_keyboard.flat().find((b:{text:string})=>b.text===label);expect(button).toBeDefined();return run({kind:'clientAction',callbackId:button.callback_data});};
 await run({kind:'start',payload:null});await click('🛠 Управление');await click('Услуги');await click('Создать');await run({kind:'saveDraftInput',text:'SQL reviewed service'});
 expect((await sql.query("SELECT id FROM services WHERE name='SQL reviewed service'")).rows).toHaveLength(0);expect((await current()).text).toContain('SQL reviewed service');
 const screen=await current(),callbackId=screen.reply_markup.inline_keyboard.flat().find((b:{text:string})=>b.text==='Подтвердить').callback_data;
 expect((await run({kind:'clientAction',callbackId})).status).toBe('saved');expect((await run({kind:'clientAction',callbackId})).status).toBe('stale_callback');expect((await sql.query("SELECT id FROM services WHERE name='SQL reviewed service'")).rows).toHaveLength(1);
});
async function recoveryWizard(){
 await sql.query("WITH u AS (INSERT INTO telegram_users(telegram_id,last_seen_at) VALUES(202,$1) RETURNING id) INSERT INTO roles(user_id,role) SELECT id,'admin' FROM u",[now]);
 const run=(command:Command)=>execute('201',command);
 const current=async()=>{const row=(await sql.query("SELECT payload FROM outbox WHERE kind='client_screen' AND chat_id=201 AND status='pending' ORDER BY due_at,id LIMIT 1")).rows[0];expect(row).toBeDefined();return row.payload;};
 const button=async(label:string)=>{const screen=await current(),b=screen.reply_markup.inline_keyboard.flat().find((b:{text:string})=>b.text===label||b.text.includes(label));expect(b).toBeDefined();return b.callback_data as string;};
 const click=async(label:string)=>run({kind:'clientAction',callbackId:await button(label)});
 await run({kind:'start',payload:null});await click('🛠 Управление');return {run,current,button,click};
}
it('admin review recovery rebases a concurrent owner change before first tariff review',async()=>{
 const f=await recoveryWizard();await f.click('Ранги');await f.click('Тестовый ранг');await f.click('Услуги и тарифы');await f.click('Тестовая стрижка');await f.click('Задать тариф');await f.run({kind:'saveDraftInput',text:'1700,12'});
 expect((await execute('202',{kind:'saveRank',rankId:rank,expectedVersion:1,name:'Concurrent rank'})).status).toBe('saved');
 await f.run({kind:'saveDraftInput',text:'83'});expect((await f.current()).text).toContain('Concurrent rank');const submit=await f.button('Подтвердить');expect((await f.click('Подтвердить')).status).toBe('saved');
 expect((await sql.query('SELECT price_kopecks,duration_minutes FROM rank_tariffs WHERE rank_id=$1 AND service_id=$2',[rank,s])).rows[0]).toEqual({price_kopecks:170012,duration_minutes:83});expect((await sql.query('SELECT version FROM ranks WHERE id=$1',[rank])).rows[0].version).toBe(3);
 expect((await f.run({kind:'clientAction',callbackId:submit})).status).toBe('stale_callback');expect((await sql.query('SELECT version FROM ranks WHERE id=$1',[rank])).rows[0].version).toBe(3);
});
it('admin review recovery preserves concurrent rename in a rank-only wizard before first review',async()=>{
 const f=await recoveryWizard(),newRank=await execute('202',{kind:'saveRank',rankId:null,expectedVersion:null,name:'New selected rank'});expect(newRank.status).toBe('saved');
 await f.click('Мастера');await f.click('Вымышленный мастер');await f.click('Изменить ранг');expect((await execute('202',{kind:'saveBarber',barberId:b,expectedVersion:1,name:'Concurrent barber rename',rankId:rank})).status).toBe('saved');
 await f.click('New selected rank');const review=await f.current();expect(review.text).toContain('Concurrent barber rename');expect(review.text).toContain('New selected rank');expect((await f.click('Подтвердить')).status).toBe('saved');
 expect((await sql.query('SELECT name,rank_id,version FROM barbers WHERE id=$1',[b])).rows[0]).toEqual({name:'Concurrent barber rename',rank_id:newRank.entityId,version:3});
});
