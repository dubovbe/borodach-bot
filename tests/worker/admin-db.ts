import {clientDatabase,fixtureBarber,fixtureService} from './client-db';
import type {Database,Tx} from '../../src/db/client';
// SQL boundary only: real Repository, admin controller and domain mutations run unchanged.
export function adminDatabase(){
 const base=clientDatabase(),ranks=new Map<string,any>(),services=new Map<string,any>(),barbers=new Map<string,any>(),assignments=new Map<string,any>(),rankTariffs=new Map<string,any>(),overrides=new Map<string,any>();
 const rank='00000000-0000-4000-8000-000000000001';
 ranks.set(rank,{id:rank,name:'Тестовый ранг',version:1,archived_at:null});services.set(fixtureService,{id:fixtureService,name:'Тестовая стрижка',version:1,archived_at:null});barbers.set(fixtureBarber,{id:fixtureBarber,name:'Вымышленный мастер',version:1,rank_id:rank,archived_at:null});
 const weeklyHours=new Map<number,{startMinute:number;endMinute:number}[]>([1,2,3,4,5,6,7].map(day=>[day,[{startMinute:0,endMinute:1200}]]));
 const settings={id:crypto.randomUUID(),version:1,booking_horizon_days:30};
 const tables:any={services,ranks,barbers};
 const wrap=(tx:Tx):Tx=>({...tx,query:async<T>(sql:string,v:unknown[]=[])=>{
 const args=v as any[];let result:any[]|undefined;
 const active=/^SELECT \* FROM (services|ranks|barbers) WHERE id::text=/.exec(sql),list=/^SELECT id,name,version FROM (services|ranks|barbers)/.exec(sql);
 if(active){const e=tables[active[1]].get(args[0]);result=e&&!e.archived_at?[structuredClone(e)]:[];}
 else if(list)result=[...tables[list[1]].values()].filter((e:any)=>!e.archived_at).sort((a:any,b:any)=>a.name.localeCompare(b.name)).slice(args[0],args[0]+6);
 else if(sql.startsWith('SELECT jsonb_build_object(')){
  const [service,rankId,barber]=args,d=barbers.get(barber),safe=d?Object.fromEntries(Object.entries(d).filter(([key])=>key!=='public_token_hash')):null;result=[{snapshot:structuredClone({service:services.get(service)??null,rank:ranks.get(rankId)??null,barber:safe,barberRank:ranks.get(d?.rank_id)??null,rankTariff:rankTariffs.get(`${rankId??d?.rank_id}:${service}`)??null,override:overrides.get(`${barber}:${service}`)??null,assignment:assignments.get(`${barber}:${service}`)??null,invitations:[],settings})}];
 }
 else if(/^INSERT INTO (services|ranks|barbers)\(name/.test(sql)){const table=/^INSERT INTO (\w+)/.exec(sql)![1],id=crypto.randomUUID(),e={id,name:args[0],version:1,archived_at:null,...(table==='barbers'?{rank_id:args[1]}:{})};tables[table].set(id,e);result=[{id}];}
 else if(/^UPDATE (services|ranks|barbers) SET name=/.test(sql)){const table=/^UPDATE (\w+)/.exec(sql)![1],e=tables[table].get(args[table==='barbers'?2:1]);Object.assign(e,{name:args[0],version:e.version+1,...(table==='barbers'?{rank_id:args[1]}:{})});result=[{id:e.id}];}
 else if(sql.startsWith('INSERT INTO assignments')){assignments.set(`${args[0]}:${args[1]}`,{barber_id:args[0],service_id:args[1]});result=[];}
 else if(sql.startsWith('DELETE FROM assignments')){assignments.delete(`${args[0]}:${args[1]}`);result=[];}
 else if(/^INSERT INTO (rank_tariffs|barber_tariffs)/.test(sql)){const map=sql.includes('rank_tariffs')?rankTariffs:overrides;map.set(`${args[0]}:${args[1]}`,{price_kopecks:args[2],duration_minutes:args[3]});result=[];}
 else if(sql.startsWith('DELETE FROM barber_tariffs')){overrides.delete(`${args[0]}:${args[1]}`);result=[];}
 else if(/^UPDATE (ranks|barbers) SET version=version\+1/.test(sql)){const table=/^UPDATE (\w+)/.exec(sql)![1],e=tables[table].get(args[0]);e.version++;result=[];}
 else if(sql.startsWith('SELECT weekday,start_minute'))result=[...weeklyHours.entries()].flatMap(([weekday,intervals])=>intervals.map(i=>({weekday,start_minute:i.startMinute,end_minute:i.endMinute})));
 else if(sql.startsWith('SELECT visit_id,kind,start_at,end_at'))result=[];
 else if(sql.startsWith('WITH removed AS (DELETE FROM weekly_hours')){weeklyHours.set(args[1],JSON.parse(args[2]).map((i:any)=>({startMinute:i.start_minute,endMinute:i.end_minute})));barbers.get(args[0]).version++;result=[];}
 else if(sql.startsWith('WITH audit AS (INSERT INTO audit_events'))result=[];
 else if(sql.startsWith('SELECT role FROM roles WHERE user_id=(SELECT'))result=base.user(args[0]).roles.map((role:string)=>({role}));
 return result as T[]??await tx.query<T>(sql,v);
 }});
 const database:Database={transaction:run=>base.database.transaction(tx=>run(wrap(tx))),read:run=>base.database.read(reader=>run(wrap({...reader,now:base.now})))};
 return {...base,database,ranks,services,barbers,assignments,rankTariffs,overrides,settings,weeklyHours};
}
