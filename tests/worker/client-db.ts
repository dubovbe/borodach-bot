// SQL boundary double: no controller/renderer/booking/Outbox functions are mocked.
// PostgreSQL locking, constraints and real SQL execution are covered in integration/client-flow.
import type { Database, Tx } from '../../src/db/client';
export const fixtureBarber='00000000-0000-4000-8000-000000000002';
export const fixtureService='00000000-0000-4000-8000-000000000003';
export function clientDatabase(){
  const now='2026-11-06T04:00:00.000Z',users=new Map<string,any>(),drafts=new Map<string,any>(),callbacks=new Map<string,any>(),staffCallbacks=new Map<string,any>(),transferCallbacks=new Map<string,any>(),transfers=new Map<string,any>(),results=new Map<string,any>(),visits=new Map<string,any>(),outbox:any[]=[];
  let price=150000, empty=false, noWork=false,reportValue='0';
  const user=(id:string)=>{if(!users.has(id))users.set(id,{id:crypto.randomUUID(),telegram_id:id,version:1,roles:id==='200'?['barber']:['client'],client:crypto.randomUUID(),name:'',phone:null,verified:false,reminder_hours:2});return users.get(id);};
  const byId=(id:string)=>[...users.values()].find(u=>u.id===id);
  const uid=(id:string)=>user(id).id;
  const record=(v:any)=>outbox.push({id:crypto.randomUUID(),status:'pending',due_at:now,attempts:0,entity_id:null,entity_version:null,entity_type:null,...v});
  const query=async(sql:string,v:any[]=[]):Promise<any[]>=>{
    if(sql.startsWith('SELECT * FROM entry_callbacks'))return [];
    if(sql.startsWith('SELECT\n  EXISTS(SELECT 1 FROM roles')){const u=byId(v[0]);return u?[{admin:u.roles.includes('admin'),barber:u.roles.includes('barber'),own:u.telegram_id==='200'?fixtureBarber:null,active:true}]:[];}
    if(sql.startsWith('SELECT p.id,p.client_id,p.user_id'))return [];
    if(sql.startsWith('SELECT id FROM clients WHERE user_id IS NULL'))return [];
    if(sql.startsWith('SELECT v.id,v.version,v.status,v.barber_id'))return [];
    if(sql.startsWith('WITH actor AS (')){const u=user(v[0]);return [{allowed:u.roles.includes('admin')||u.telegram_id==='200'&&u.roles.includes('barber')&&(!v[1]||v[1]===fixtureBarber),completed:'0',no_shows:'0',value:reportValue}];}
    if(sql.startsWith('SELECT v.*,cl.user_id')){
      const x=visits.get(v[0]);return x?[{...x,schedule_generation:x.schedule_generation??1,client_user_id:[...users.values()].find(u=>u.client===x.client_id)?.id??null,barber_user_id:x.barber_user_id??uid('200'),barber_active:true,barber:'Вымышленный мастер',actor_roles:byId(v[1])?.roles??[],author_roles:byId(v[2])?.roles??[]}]:[];
    }
    if(sql.startsWith('SELECT v.id,v.version,v.start_at,b.name AS barber'))return [...visits.values()].filter(x=>x.status==='confirmed'&&Date.parse(x.start_at)>Date.parse(v[1])&&byId(v[0])?.roles.some((r:string)=>r==='admin'||r==='barber')&&[...users.values()].find(u=>u.client===x.client_id)?.id!==v[0]).map(x=>({...x,barber:'Вымышленный мастер'})).slice(v[2],v[2]+6);
    if(sql.startsWith('SELECT EXISTS(SELECT 1 FROM transfers'))return [{same:[...transfers.values()].some(t=>t.visit_id===v[0]&&t.status==='pending'),client_pending:false}];
    if(sql.startsWith('WITH inserted AS')){const t={id:crypto.randomUUID(),visit_id:v[0],initiator:v[1],status:'pending',new_start_at:v[2],new_end_at:v[3],deadline:v[4],reason:v[5],initiator_user_id:v[6],context:JSON.parse(v[7]),version:1};transfers.set(t.id,t);return [{id:t.id}];}
    if(sql.startsWith('SELECT * FROM transfers'))return transfers.has(v[0])?[transfers.get(v[0])]:[];
    if(sql.startsWith('SELECT DISTINCT u.id,u.telegram_id::text FROM telegram_users'))return [...users.values()].filter(u=>u.id===v[0]||u.roles.includes('barber')||u.roles.includes('admin')||visits.get(v[1])?.client_id===u.client).map(u=>({id:u.id,telegram_id:u.telegram_id}));
    if(sql.startsWith('WITH buttons AS')){for(const b of JSON.parse(v[4]))transferCallbacks.set(b.id,{...b,user_id:v[0],transfer_id:v[1],transfer_version:v[2],expires_at:v[3],consumed_at:null});record({logical_key:v[5],kind:'booking',chat_id:v[7],payload:JSON.parse(v[8]),entity_id:v[1],entity_version:v[2],entity_type:'transfer'});return [];}
    if(sql.startsWith('SELECT id,action FROM transfer_callbacks'))return v[0].map((id:string)=>transferCallbacks.get(id)).filter((b:any)=>b&&b.transfer_id===v[1]&&b.user_id===v[2]&&b.transfer_version===v[3]&&!b.consumed_at&&Date.parse(b.expires_at)>Date.parse(v[4]));
    if(sql.startsWith('WITH moved AS')){const x=visits.get(v[0]);Object.assign(x,{start_at:v[1],end_at:v[2],version:x.version+1,schedule_generation:(x.schedule_generation??1)+1});Object.assign(transfers.get(v[3]),{status:'accepted',version:2,agreed_by:v[4],agreed_at:v[5],agreement_channel:v[6]});for(const o of outbox)if(o.entity_id===x.id&&['pending','leased'].includes(o.status))o.status='cancelled';return [];}
    if(sql.startsWith("UPDATE transfers SET status='declined'")){Object.assign(transfers.get(v[0]),{status:'declined',version:2});return [];}
    if(sql.startsWith("UPDATE transfers SET status='cancelled'")){const changed=[...transfers.values()].filter(t=>v[0].includes(t.visit_id)&&t.status==='pending');for(const t of changed)Object.assign(t,{status:'cancelled',version:t.version+1});return changed.map(t=>({id:t.id,visit_id:t.visit_id}));}
    if(sql.startsWith('WITH held AS')){for(const b of transferCallbacks.values())if(b.transfer_id===v[0])b.consumed_at=v[1];for(const o of outbox)if(o.entity_id===v[0]&&['pending','leased'].includes(o.status))o.status='cancelled';return [];}
    if(sql.startsWith('SELECT status,version FROM transfers')){const t=transfers.get(v[0]);return t?[{status:t.status,version:t.version}]:[];}
    if(sql.startsWith('SELECT reminder_hours,phone'))return [{reminder_hours:byId(v[0]).reminder_hours,phone:byId(v[0]).phone}];
    if(sql.startsWith('SELECT reminder_hours FROM clients'))return [{reminder_hours:byId(v[0]).reminder_hours}];
    if(sql.startsWith('UPDATE clients SET reminder_hours')){byId(v[0]).reminder_hours=v[1];return [];}
    if(sql.startsWith('SELECT v.id,v.version,v.schedule_generation,v.start_at'))return [...visits.values()].filter(x=>x.status==='confirmed'&&Date.parse(x.start_at)>Date.parse(v[0])&&(!v[1]||[...users.values()].find(u=>u.client===x.client_id)?.id===v[1])&&(!v[2]||x.id===v[2])).map(x=>{const u=[...users.values()].find(u=>u.client===x.client_id);return {...x,chat_id:u.telegram_id,reminder_hours:u.reminder_hours,confirmed_at:null,reminders:outbox.filter(o=>o.kind==='reminder'&&o.entity_id===x.id).map(o=>({...o,sent_at:o.sent_at??null}))};});
    if(sql.startsWith('WITH cancelled AS')){
      for(const o of outbox)if(v[0].includes(o.id))Object.assign(o,{status:'cancelled',claim_token:null});
      for(const p of JSON.parse(v[1])){const o=outbox.find(o=>o.logical_key===p.key);if(o)Object.assign(o,{payload:p.payload,due_at:p.dueAt,status:'pending',claim_token:null});else record({logical_key:p.key,kind:'reminder',chat_id:p.chatId,payload:p.payload,due_at:p.dueAt,entity_id:p.visitId,entity_version:p.version,entity_type:'visit',sent_at:null});}
      return [];
    }
    if(sql.startsWith('SELECT v.id,v.version,v.status,v.start_at'))return [...visits.values()].filter(x=>[...users.values()].find(u=>u.client===x.client_id)?.id===v[0]&&['pending','confirmed'].includes(x.status)&&Date.parse(x.start_at)>Date.parse(v[1])).sort((a,b)=>a.start_at.localeCompare(b.start_at)).slice(v[2],v[2]+6).map(x=>({...x,barber:'Вымышленный мастер',items:x.items.map((i:any)=>i.name).join(', ')}));
    if(sql.startsWith('SELECT v.id,v.version,v.status FROM visits')){const x=visits.get(v[0]);return x&&[...users.values()].find(u=>u.client===x.client_id)?.id===v[1]&&Date.parse(x.start_at)>Date.parse(v[2])?[x]:[];}
    if(sql.startsWith('SELECT v.id FROM visits v JOIN clients')){const x=visits.get(v[0]);return x&&x.version===v[1]&&x.status==='confirmed'&&Date.parse(x.start_at)>Date.parse(v[2])&&[...users.values()].find(u=>u.client===x.client_id)?.telegram_id===v[3]?[{id:x.id}]:[];}
    if(sql.startsWith('SELECT result FROM processed_updates'))return results.has(v[0])?[{result:results.get(v[0])}]:[];
    if(sql.startsWith('INSERT INTO processed_updates')){results.set(v[0],JSON.parse(v[2]));return [];}
    if(sql.startsWith('INSERT INTO telegram_users'))return [{id:uid(v[0])}];
    if(sql.startsWith("SELECT d.state->>'scope' AS scope")){const d=[...drafts.values()].find(d=>d.user_id===v[0]);return d?[{scope:d.state.scope??null,admin:byId(v[0]).roles.includes('admin')}]:[];}
    if(sql.startsWith('SELECT * FROM drafts'))return [...drafts.values()].filter(d=>d.user_id===v[0]);
    if(sql.startsWith('WITH ended AS')){for(const d of drafts.values())if(d.user_id===v[0]){d.expires_at=v[1];d.version++;for(const o of outbox)if(o.draft_id===d.id&&['pending','leased'].includes(o.status))o.status='cancelled';}return [];}
    if(sql.startsWith('INSERT INTO drafts')){let d=[...drafts.values()].find(d=>d.user_id===v[0]);d={id:d?.id??crypto.randomUUID(),user_id:v[0],barber_id:v[1],state:JSON.parse(v[2]),expires_at:new Date(Date.parse(now)+1800000).toISOString(),version:(d?.version??0)+1};drafts.set(d.id,d);return [structuredClone(d)];}
    if(sql.startsWith('UPDATE drafts SET barber_id')){const d=drafts.get(v[0]);Object.assign(d,{barber_id:v[1],state:JSON.parse(v[2]),version:d.version+1});return [structuredClone(d)];}
    if(sql.startsWith('WITH updated AS')){
      const d=drafts.get(v[0]);if(!d||d.user_id!==v[3]||d.version!==v[4]||Date.parse(d.expires_at)<=Date.parse(v[5]))return [];
      Object.assign(d,{barber_id:v[1],state:JSON.parse(v[2]),version:d.version+1});
      for(const o of outbox)if(o.draft_id===d.id&&['pending','leased'].includes(o.status))Object.assign(o,{status:'cancelled',claim_token:null,lease_until:null});
      for(const b of JSON.parse(v[6]))callbacks.set(b.id,{id:b.id,user_id:d.user_id,draft_id:d.id,draft_version:d.version,action:b.action,expires_at:new Date(Math.min(Date.parse(d.expires_at),Date.parse(v[5])+1800000)).toISOString(),consumed_at:null});
      record({logical_key:v[7],kind:'client_screen',chat_id:byId(d.user_id).telegram_id,payload:JSON.parse(v[9]),draft_id:d.id,draft_version:d.version});return [structuredClone(d)];
    }
    if(sql.startsWith('INSERT INTO callbacks')){for(const b of JSON.parse(v[5]))callbacks.set(b.id,{id:b.id,user_id:v[0],draft_id:v[1],draft_version:v[2],action:b.action,expires_at:v[3],consumed_at:null});return [];}
    if(sql.startsWith('SELECT * FROM callbacks'))return callbacks.has(v[0])?[callbacks.get(v[0])]:[];
    if(sql.startsWith('UPDATE callbacks SET consumed_at')){callbacks.get(v[0]).consumed_at=v[1];return [];}
    if(sql.startsWith('SELECT * FROM transfer_callbacks'))return transferCallbacks.has(v[0])?[transferCallbacks.get(v[0])]:[];
    if(sql.startsWith('SELECT * FROM staff_callbacks'))return staffCallbacks.has(v[0])?[staffCallbacks.get(v[0])]:[];
    if(sql.startsWith('INSERT INTO staff_callbacks')){for(const b of JSON.parse(v[4]))staffCallbacks.set(b.id,{...b,user_id:v[0],visit_id:v[1],visit_version:v[2],expires_at:v[3],consumed_at:null});return [];}
    if(sql.startsWith('UPDATE staff_callbacks SET consumed_at')){staffCallbacks.get(v[0]).consumed_at=v[1];return [];}
    if(sql.startsWith('SELECT id,action FROM staff_callbacks'))return v[0].map((id:string)=>staffCallbacks.get(id));
    if(sql.startsWith('UPDATE outbox SET status=\'cancelled\'')&&sql.includes('draft_id=$1')){for(const o of outbox)if(o.draft_id===v[0]&&['pending','leased'].includes(o.status))Object.assign(o,{status:'cancelled',claim_token:null,lease_until:null});return [];}
    if(sql.startsWith('INSERT INTO outbox')){
      if(sql.includes("'client_screen'"))record({logical_key:v[0],payload:JSON.parse(v[2]),draft_id:v[4],draft_version:v[5],kind:'client_screen',chat_id:byId(v[6]).telegram_id});
      else if(sql.includes("'booking'"))record({logical_key:v[0],payload:JSON.parse(v[3]),kind:'booking',chat_id:v[2],entity_id:v[5],entity_version:v[6],entity_type:'visit'});
      else record({logical_key:v[0],payload:JSON.parse(v[4]??v[2]),kind:'start',chat_id:typeof v[3]==='string'&&/^\d+$/.test(v[3])?v[3]:'100'});
      return [];
    }
    if(sql.startsWith('SELECT id,name FROM barbers'))return empty?[]:[{id:fixtureBarber,name:'Вымышленный мастер'}];
    if(sql.startsWith('SELECT id FROM barbers'))return v[0]===fixtureBarber?[{id:fixtureBarber}]:[];
    if(sql.startsWith('SELECT s.id,s.name'))return empty?[]:[{id:fixtureService,name:'Тестовая стрижка'},{id:'00000000-0000-4000-8000-000000000004',name:'Тестовая борода'}];
    if(sql.startsWith('SELECT s.id AS service_id'))return empty?[]:v[1].filter((id:string)=>[fixtureService,'00000000-0000-4000-8000-000000000004'].includes(id)).map((id:string)=>({service_id:id,name:id===fixtureService?'Тестовая стрижка':'Тестовая борода',price_kopecks:price,duration_minutes:45}));
    if(sql.startsWith('SELECT weekday,start_minute'))return noWork?[]:[1,2,3,4,5,6,7].map(weekday=>({weekday,start_minute:0,end_minute:1200}));
    if(sql.startsWith('SELECT local_date::text'))return [];
    if(sql.startsWith('SELECT booking_horizon_days'))return [{booking_horizon_days:30}];
    if(sql.startsWith('SELECT start_at,end_at FROM holds'))return [...visits.values()].filter(x=>['pending','confirmed'].includes(x.status)&&x.id!==v[2]).map(x=>({start_at:x.start_at,end_at:x.end_at}));
    if(sql.startsWith('SELECT b.name,s.address'))return [{name:'Вымышленный мастер',address:'Вымышленная улица, 1',identity:{id:fixtureBarber,name:'Вымышленный мастер',address:'Вымышленная улица, 1'}}];
    if(sql.startsWith('SELECT c.name,EXISTS')){const u=byId(v[0]);return [{name:u.name,verified:u.verified}];}
    if(sql.startsWith('UPDATE clients SET name')){byId(v[0]).name=v[1];return [];}
    if(sql.startsWith('SELECT role FROM roles'))return byId(v[0]).roles.map((role:string)=>({role}));
    if(sql.startsWith('SELECT c.id,c.name FROM clients')){const u=byId(v[0]);return u.name&&u.verified?[{id:u.client,name:u.name}]:[];}
    if(sql.startsWith('SELECT id FROM visits WHERE client_id'))return [...visits.values()].filter(x=>x.client_id===v[0]&&x.status==='pending');
    if(sql.startsWith('INSERT INTO visits')){const visit={id:crypto.randomUUID(),client_id:v[0],barber_id:v[1],status:v[2],start_at:v[3],end_at:v[4],deadline:v[5],version:1,items:[]};visits.set(visit.id,visit);return [{id:visit.id}];}
    if(sql.startsWith('INSERT INTO visit_items')){visits.get(v[0]).items=JSON.parse(v[1]);return [];}
    if(sql.startsWith('SELECT v.*,c.user_id')){const visit=visits.get(v[0]);return visit?[{...visit,client_user_id:[...users.values()].find(u=>u.client===visit.client_id).id,barber_user_id:uid('200'),barber_active:true}]:[];}
    if(sql.startsWith('UPDATE visits SET status=$1')){Object.assign(visits.get(v[1]),{status:v[0],version:visits.get(v[1]).version+1});return [];}
    if(sql.startsWith('WITH entity AS')){const visit=visits.get(v[1]);for(const o of outbox)if(o.entity_id===visit.id&&o.entity_version!==visit.version)o.status='cancelled';const snapshot={barber:'Вымышленный мастер',address:'Вымышленная улица, 1',start:visit.start_at,items:visit.items};for(const id of v[5]==='visit_pending'?['100']:['100','200'])record({kind:'booking',chat_id:id,entity_id:visit.id,entity_version:visit.version,entity_type:'visit',payload:{event:v[5],visitId:visit.id,snapshot}});return [{version:visit.version}];}
    if(sql.startsWith('SELECT u.id,u.telegram_id::text FROM visits'))return [{id:uid('200'),telegram_id:'200'}];
    if(sql.startsWith('SELECT v.id,v.version,v.deadline')){const visit=visits.get(v[0]);if(!visit||visit.status!=='pending'||v[1]!==uid('200'))return [];const u=[...users.values()].find(u=>u.client===visit.client_id);return [{...visit,name:u.name,phone:u.phone,barber:'Вымышленный мастер',items:visit.items.map((i:any)=>({name:i.name,price:i.priceKopecks,duration:i.durationMinutes}))}];}
    if(sql.startsWith('SELECT id FROM telegram_users WHERE id='))return byId(v[0])?.telegram_id===v[1]?[{id:v[0]}]:[];
    if(sql.startsWith('SELECT min(due)'))return [{due:outbox.some(o=>o.status==='pending')?now:null}];
    if(sql.startsWith('SELECT u.id,NOT EXISTS'))return [{id:uid(v[0]),first_contact:false}];
    if(sql.startsWith('SELECT user_id FROM phone_claims'))return [];
    if(sql.startsWith('INSERT INTO clients(user_id,name,phone)')){const u=byId(v[0]);u.phone=v[1];return [{id:u.client}];}
    if(sql.startsWith('WITH released AS')){byId(v[0]).verified=true;return [];}
    if(sql.startsWith('UPDATE outbox SET status=\'leased\'')){const o=outbox.find(o=>o.status==='pending'&&Date.parse(o.due_at)<=Date.parse(v[0])||o.status==='leased'&&Date.parse(o.lease_until??o.due_at)<=Date.parse(v[0]));if(!o)return [];Object.assign(o,{status:'leased',claim_token:crypto.randomUUID(),lease_until:new Date(Date.parse(v[0])+30000).toISOString(),attempts:o.attempts+1});return [structuredClone(o)];}
    if(sql.startsWith('SELECT id FROM outbox WHERE'))return outbox.some(o=>o.id===v[0]&&o.claim_token===v[1]&&o.status==='leased')?[{id:v[0]}]:[];
    if(sql.startsWith('SELECT unreachable_at,version'))return [{version:1,unreachable_at:null}];
    if(sql.startsWith('SELECT d.id FROM drafts')){const d=drafts.get(v[0]);return d&&d.version===v[1]?[{id:d.id}]:[];}
    if(sql.startsWith('SELECT status,version FROM visits')){const visit=visits.get(v[0]);return visit?[{status:visit.status,version:visit.version}]:[];}
    if(sql.startsWith('UPDATE outbox SET status=$3')){const o=outbox.find(o=>o.id===v[0]&&o.claim_token===v[1]&&o.status==='leased');if(!o)return [];Object.assign(o,{status:v[2],claim_token:null,lease_until:null,...(v[2]==='sent'?{sent_at:v[5]}:{}),...(v[6]?{due_at:v[6]}:{})});return [{id:o.id}];}
    if(/^(SAVEPOINT|RELEASE|ROLLBACK TO|INSERT INTO roles|INSERT INTO clients|INSERT INTO audit_events|INSERT INTO holds|INSERT INTO jobs|UPDATE jobs|UPDATE holds|UPDATE visits SET status='expired'|UPDATE transfers|DELETE FROM holds)/.test(sql))return [];
    throw Error(`Unhandled SQL boundary: ${sql.slice(0,90)}`);
  };
  const tx:Tx={now,query};
  const database:Database={read:run=>run({query}),transaction:run=>run(tx)};
  return {database,now,users,drafts,callbacks,transferCallbacks,transfers,outbox,visits,user,setPrice:(n:number)=>{price=n;},setReportValue:(value:string)=>{reportValue=value;},setEmpty:()=>{empty=true;},setNoWork:()=>{noWork=true;}};
}
