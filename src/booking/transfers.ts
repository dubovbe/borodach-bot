import type { Instant, Interval } from '../domain/types';
import { approvalDeadline } from '../schedule/service';
export function transferDeadline(input:{initiator:'client'|'staff';now:Instant;oldStart:Instant;newStart:Instant;work:Interval[]}):Instant|null {
 const rule=input.initiator==='client'?approvalDeadline(input.now,input.work):new Date(Date.parse(input.now)+3600000).toISOString();
 if(!rule)return null;
 const deadline=Math.min(Date.parse(rule),Date.parse(input.oldStart),Date.parse(input.newStart));
 return Number.isFinite(deadline)&&deadline>Date.parse(input.now)?new Date(deadline).toISOString():null;
}
import { DomainError,type TransferCommand,type CommandResult,type OfferItem } from '../domain/types';
import type { Context } from './service';
import {nextDue} from './service';
import {busyIntervals,loadSchedule,localDate,workBetween,firstApprovalWork} from '../schedule/service';
import {reconcileReminders} from '../notifications/reminders';
import type {Tx} from '../db/client';
const stamp=(v:Date|string)=>new Date(v).toISOString();
const deny=(code='forbidden'):never=>{throw new DomainError(code,'Перенос недоступен. Обновите данные.');};
type Snapshot={visitVersion:number;clientId:string;clientUserId:string|null;barberId:string;oldStart:string;oldEnd:string;scheduleGeneration:number};
type Visit={id:string;client_id:string;client_user_id:string|null;barber_id:string;barber_user_id:string|null;barber_active:boolean;barber:string;status:string;version:number;schedule_generation:number;start_at:Date|string;end_at:Date|string;items:OfferItem[];actor_roles:string[];author_roles:string[]};
type Transfer={id:string;visit_id:string;initiator:'client'|'staff';status:string;version:number;new_start_at:Date|string;new_end_at:Date|string;deadline:Date|string;reason:string|null;initiator_user_id:string|null;context:Snapshot|null};
export const validTransferReason=(s:string)=>s.trim().length>=1&&s.trim().length<=500&&!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s);
async function visitFor(c:Context,visitId:string,authorId:string|null=null):Promise<Visit>{
 const v=(await c.tx.query<Visit>(`SELECT v.*,cl.user_id AS client_user_id,b.user_id AS barber_user_id,b.archived_at IS NULL AS barber_active,b.name AS barber,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('serviceId',i.service_id,'name',i.name,'priceKopecks',i.price_kopecks,'durationMinutes',i.duration_minutes) ORDER BY i.id) FROM visit_items i WHERE i.visit_id=v.id),'[]'::jsonb) AS items,
  ARRAY(SELECT role FROM roles WHERE user_id=$2) AS actor_roles,ARRAY(SELECT role FROM roles WHERE user_id=$3) AS author_roles
  FROM visits v JOIN clients cl ON cl.id=v.client_id JOIN barbers b ON b.id=v.barber_id WHERE v.id::text=$1`,[visitId,c.userId,authorId]))[0];
 if(!v)deny('not_found');return v;
}
function staff(v:Visit,id:string|null,roles:string[]){return !!id&&v.barber_active&&(roles.includes('admin')||v.barber_user_id===id&&roles.includes('barber'));}
function client(v:Visit,id:string|null,roles:string[]){return !!id&&v.client_user_id===id&&roles.includes('client');}
function snapshot(v:Visit):Snapshot{return {visitVersion:v.version,clientId:v.client_id,clientUserId:v.client_user_id,barberId:v.barber_id,oldStart:stamp(v.start_at),oldEnd:stamp(v.end_at),scheduleGeneration:v.schedule_generation};}
function matches(t:Transfer,v:Visit){const s=t.context;return !!s&&s.visitVersion===v.version&&s.clientId===v.client_id&&s.clientUserId===v.client_user_id&&s.barberId===v.barber_id&&s.oldStart===stamp(v.start_at)&&s.oldEnd===stamp(v.end_at)&&s.scheduleGeneration===v.schedule_generation&&v.status==='confirmed';}
function authorAllowed(t:Transfer,v:Visit){return t.initiator==='client'?client(v,t.initiator_user_id,v.author_roles):staff(v,t.initiator_user_id,v.author_roles);}
function approver(t:Transfer,v:Visit,id:string|null,roles:string[],phone=false){
 if(phone)return t.initiator==='staff'&&v.client_user_id===null&&staff(v,id,roles);
 if(id===t.initiator_user_id)return false;
 return t.initiator==='client'?v.client_user_id!==id&&staff(v,id,roles):client(v,id,roles);
}
function frozenDuration(v:Visit){
 if(!v.items.length||!v.items.every(i=>typeof i.name==='string'&&i.name.length>0&&Number.isSafeInteger(i.durationMinutes)&&i.durationMinutes>0&&Number.isSafeInteger(i.priceKopecks)&&i.priceKopecks>=0))deny('invalid_snapshot');
 const duration=v.items.reduce((n,i)=>n+i.durationMinutes,0);if(!Number.isSafeInteger(duration)||duration<=0||Date.parse(stamp(v.end_at))-Date.parse(stamp(v.start_at))!==duration*60000)deny('invalid_snapshot');return duration;
}
// The visit is loaded and authorized before its own intervals can be excluded.
export async function prepareTransferAvailability(c:Context,visitId:string,expectedVersion:number,side:'client'|'staff'){
 const v=await visitFor(c,visitId);
 if(side==='client'?!client(v,c.userId,v.actor_roles):!staff(v,c.userId,v.actor_roles))deny();
 if(v.version!==expectedVersion)deny('stale_version');
 if(v.status!=='confirmed'||Date.parse(stamp(v.start_at))<=Date.parse(c.tx.now))deny('invalid_state');
 if(!v.barber_active)deny('slot_unavailable');
 if(side==='staff'&&v.client_user_id===c.userId)deny();
 const duration=frozenDuration(v),schedule=await loadSchedule(v.barber_id,c.tx);
 const settings=(await c.tx.query<{booking_horizon_days:number}>('SELECT booking_horizon_days FROM settings WHERE shop_id=1',[]))[0];
 const busy=await busyIntervals(v.barber_id,c.tx,v.id),horizon=settings?.booking_horizon_days??30;
 const slots=(from:string,to:string,firstPerDay=false)=>{
  const n=Date.parse(c.tx.now),lo=Date.parse(from),hi=Date.parse(to);
  if(!Number.isFinite(lo)||!Number.isFinite(hi)||hi<lo||hi-lo>366*86400000)deny('invalid_range');
  const upper=side==='client'?Math.min(hi,Date.parse(`${localDate(c.tx.now)}T00:00:00+03:00`)+(horizon+1)*86400000-1):hi;
  const lower=Math.max(lo,n+(side==='client'?7200000:1));if(lower>upper)return [];
  const result:Array<{start:string;end:string;deadline:string}>=[];
  // Staff approval uses wall time; clients need only work up to this candidate window.
  const work=workBetween(schedule,new Date(lower).toISOString(),new Date(upper).toISOString());
  const approvalWork=side==='client'?firstApprovalWork(schedule,c.tx.now,new Date(upper).toISOString()):[];
  const found=new Set<string>();
  for(const w of work){
   const date=localDate(w.start);if(firstPerDay&&found.has(date))continue;
   let s=Math.ceil(Math.max(Date.parse(w.start),lower)/1800000)*1800000;const end=Date.parse(w.end);
   for(;s<=upper&&s+duration*60000<=end;s+=1800000){const e=s+duration*60000;if(s===Date.parse(stamp(v.start_at))||busy.some(b=>Date.parse(b.start)<e&&Date.parse(b.end)>s))continue;
    const start=new Date(s).toISOString(),deadline=transferDeadline({initiator:side,now:c.tx.now,oldStart:stamp(v.start_at),newStart:start,work:approvalWork});
    if(deadline){result.push({start,end:new Date(e).toISOString(),deadline});if(firstPerDay){found.add(date);break;}}
   }
  }return result;
 };
 return {visit:v,duration,horizon,slots,availableDays:(from:string,to:string)=>slots(from,to,true).map(slot=>localDate(slot.start))};
}
export async function executeTransfer(c:Context,command:TransferCommand):Promise<CommandResult>{
 if(command.kind==='requestTransfer'||command.kind==='proposeTransfer'){
  const side=command.kind==='requestTransfer'?'client':'staff';
  const d=await prepareTransferAvailability(c,command.visitId,command.expectedVersion,side),v=d.visit;
  if(side==='staff'&&!validTransferReason(command.reason??''))deny('reason_required');
  const pending=await c.tx.query<{same:boolean;client_pending:boolean}>(`SELECT EXISTS(SELECT 1 FROM transfers WHERE visit_id=$1 AND status='pending') AS same,
   EXISTS(SELECT 1 FROM visits WHERE client_id=$2 AND status='pending' AND deadline>$3 UNION ALL SELECT 1 FROM transfers t JOIN visits v ON v.id=t.visit_id WHERE v.client_id=$2 AND t.status='pending' AND t.initiator='client' AND t.deadline>$3) AS client_pending`,[v.id,v.client_id,c.tx.now]);
  if(pending[0]?.same)deny('pending_transfer');if(side==='client'&&pending[0]?.client_pending)deny('pending_limit');
  if(!Number.isFinite(Date.parse(command.newStart)))deny('slot_unavailable');
  const start=stamp(command.newStart),slot=d.slots(start,start)[0];if(!slot)deny('slot_unavailable');
  const t=(await c.tx.query<{id:string}>(`WITH inserted AS (
   INSERT INTO transfers(visit_id,initiator,status,new_start_at,new_end_at,deadline,reason,initiator_user_id,context)
   VALUES($1,$2,'pending',$3,$4,$5,$6,$7,$8::jsonb) RETURNING id,version
  ), held AS(INSERT INTO holds(visit_id,transfer_id,barber_id,kind,start_at,end_at,expires_at)
   SELECT $1,id,$9,'transfer',$3,$4,$5 FROM inserted), expiry AS(
   INSERT INTO jobs(logical_key,kind,visit_id,entity_version,due_at,payload) SELECT 'expire_transfer:'||id::text||':1','expire_transfer',$1,version,$5,jsonb_build_object('transferId',id) FROM inserted)
  SELECT id FROM inserted`,[v.id,side,start,slot.end,slot.deadline,side==='staff'?command.reason!.trim():null,c.userId,JSON.stringify(snapshot(v)),v.barber_id]))[0];
  await recordTransferEvent(c,'transfer_pending',t.id,v.id);
  return {entityId:t.id,status:'pending',nextWake:await nextDue(c.tx)};
 }
 const t=(await c.tx.query<Transfer>('SELECT * FROM transfers WHERE id::text=$1',[command.transferId]))[0];
 if(!t)deny('not_found');
 if(t.status!=='pending'||!t.context||!t.initiator_user_id||Date.parse(stamp(t.deadline))<=Date.parse(c.tx.now))deny('invalid_state');
 if(t.version!==command.expectedVersion||!Number.isInteger(command.expectedVersion))deny('stale_version');
 const v=await visitFor(c,t.visit_id,t.initiator_user_id),phone=command.kind==='recordPhoneAgreement';
 if(!approver(t,v,c.userId,v.actor_roles,phone))deny();
 if(!matches(t,v))deny('stale_version');
 const accept=phone||command.kind==='decideTransfer'&&command.accept;
 if(accept&&!authorAllowed(t,v))deny();
 if(accept){
  frozenDuration(v);
  if(!v.barber_active)deny('slot_unavailable');
  const busy=await busyIntervals(v.barber_id,c.tx,v.id),start=stamp(t.new_start_at),end=stamp(t.new_end_at);
  const schedule=await loadSchedule(v.barber_id,c.tx);
  if(!workBetween(schedule,start,end).some(w=>Date.parse(w.start)<=Date.parse(start)&&Date.parse(w.end)>=Date.parse(end))||busy.some(b=>Date.parse(b.start)<Date.parse(end)&&Date.parse(b.end)>Date.parse(start)))deny('slot_unavailable');
  await c.tx.query(`WITH moved AS(UPDATE visits SET start_at=$2,end_at=$3,version=version+1,schedule_generation=schedule_generation+1 WHERE id=$1 RETURNING id),
   old_hold AS(DELETE FROM holds WHERE visit_id=$1 AND kind='visit'),
   new_hold AS(UPDATE holds SET kind='visit',transfer_id=NULL,expires_at=NULL,version=version+1 WHERE transfer_id=$4),
   work AS(UPDATE outbox SET status='cancelled',claim_token=NULL,lease_until=NULL,version=version+1 WHERE entity_id=$1 AND status IN ('pending','leased') AND sent_at IS NULL),
   jobs_closed AS(UPDATE jobs SET status='cancelled',lease_until=NULL,version=version+1 WHERE visit_id=$1 AND status IN ('pending','leased'))
   UPDATE transfers SET status='accepted',agreed_by=$5,agreed_at=$6,agreement_channel=$7,version=version+1 WHERE id=$4`,[v.id,start,end,t.id,c.userId,c.tx.now,phone?'phone':'telegram']);
 }else await c.tx.query("UPDATE transfers SET status='declined',version=version+1 WHERE id=$1",[t.id]);
 await closeTransferWork(c.tx,t.id);
 await recordTransferEvent(c,accept?'transfer_accepted':'transfer_declined',t.id,v.id);
 if(accept)await reconcileReminders({...c,userId:null},{visitId:v.id,confirmedAt:c.tx.now});
 return {entityId:t.id,status:accept?'accepted':'declined',nextWake:await nextDue(c.tx)};
}
// Works for every termination path, including cancellation, expiry and protected identity linking.
export async function closeTransferWork(tx:Tx,id:string){
 await tx.query(`WITH held AS(DELETE FROM holds WHERE transfer_id=$1), callbacks AS(
  UPDATE transfer_callbacks SET consumed_at=COALESCE(consumed_at,$2) WHERE transfer_id=$1), jobs_closed AS(
  UPDATE jobs SET status='cancelled',lease_until=NULL,version=version+1 WHERE kind='expire_transfer' AND payload->>'transferId'=$1::text AND status IN ('pending','leased'))
  UPDATE outbox SET status='cancelled',claim_token=NULL,lease_until=NULL,version=version+1 WHERE entity_id=$1 AND status IN ('pending','leased') AND sent_at IS NULL`,[id,tx.now]);
}
export async function cancelLinkedTransfers(tx:Tx,visitIds:string[]){
 const c:Context={tx,userId:null,updateId:null};
 const rows=await tx.query<{id:string;visit_id:string}>("UPDATE transfers SET status='cancelled',version=version+1 WHERE visit_id=ANY($1::uuid[]) AND status='pending' RETURNING id,visit_id",[visitIds]);
 for(const t of rows){await closeTransferWork(tx,t.id);await recordTransferEvent(c,'transfer_cancelled',t.id,t.visit_id,'Клиент подключил Telegram. Требуется новое предложение.');}
}
export async function recordTransferEvent(c:Context,kind:string,id:string,visitId:string,reason?:string){
 await c.tx.query(`INSERT INTO audit_events(update_id,actor_id,source,kind,entity_id,data,created_at)
 VALUES($1,$2,$3,$4,$5,jsonb_build_object('visitId',$6::text,'reason',$7::text),$8)`,[c.updateId,c.userId,c.userId===null?'system':'user',kind,id,visitId,reason??null,c.tx.now]);
 const t=(await c.tx.query<Transfer>('SELECT * FROM transfers WHERE id=$1',[id]))[0];if(!t?.context||!t.initiator_user_id)return;
 const recipients=await c.tx.query<{id:string;telegram_id:string}>(`SELECT DISTINCT u.id,u.telegram_id::text FROM telegram_users u
 WHERE u.id=$1 OR u.id=(SELECT user_id FROM clients WHERE id=(SELECT client_id FROM visits WHERE id=$2))
 OR EXISTS(SELECT 1 FROM roles r WHERE r.user_id=u.id AND (r.role='admin' OR r.role='barber' AND u.id=(SELECT b.user_id FROM visits v JOIN barbers b ON b.id=v.barber_id WHERE v.id=$2)))`,[t.initiator_user_id,visitId]);
 for(const r of recipients){
  const v=await visitFor({...c,userId:r.id},visitId,t.initiator_user_id);
  const allowed=r.id===t.initiator_user_id?authorAllowed(t,v):client(v,r.id,v.actor_roles)||staff(v,r.id,v.actor_roles);if(!allowed)continue;
  const actions=t.status==='pending'?(approver(t,v,r.id,v.actor_roles)?['accept','decline']:approver(t,v,r.id,v.actor_roles,true)?['phone','decline']:[]):[];
  // The initiating staff may phone-confirm, but may not decline as the opposite Telegram actor.
  const callbacks=actions.filter(a=>a!=='decline'||approver(t,v,r.id,v.actor_roles)).map(action=>({id:crypto.randomUUID(),action}));
  await c.tx.query(`WITH buttons AS(INSERT INTO transfer_callbacks(id,user_id,transfer_id,transfer_version,action,expires_at)
   SELECT x.id,$1,$2,$3,x.action,$4 FROM jsonb_to_recordset($5::jsonb) AS x(id uuid,action text))
   INSERT INTO outbox(logical_key,update_id,kind,chat_id,payload,due_at,entity_id,entity_version,entity_type)
   VALUES($6,$7,'booking',$8,$9::jsonb,$10,$2,$3,'transfer')`,[r.id,id,t.version,stamp(t.deadline),JSON.stringify(callbacks),`${kind}:${id}:${t.version}:${r.id}`,c.updateId,r.telegram_id,JSON.stringify({event:kind,visitId,transferUserId:r.id,buttons:callbacks.map(b=>b.id),...(reason?{reason}:{})}),c.tx.now]);
 }
}
export async function handleTransferCallback(c:Context,id:string):Promise<CommandResult|null>{
 const cb=(await c.tx.query<{user_id:string;transfer_id:string;transfer_version:number;action:string;expires_at:Date|string;consumed_at:unknown}>('SELECT * FROM transfer_callbacks WHERE id::text=$1',[id]))[0];
 if(!cb)return null;if(cb.user_id!==c.userId)deny();
 if(cb.consumed_at||Date.parse(stamp(cb.expires_at))<=Date.parse(c.tx.now))return {status:'stale_callback',nextWake:await nextDue(c.tx)};
 const command:TransferCommand=cb.action==='phone'?{kind:'recordPhoneAgreement',transferId:cb.transfer_id,expectedVersion:cb.transfer_version}:{kind:'decideTransfer',transferId:cb.transfer_id,expectedVersion:cb.transfer_version,accept:cb.action==='accept'};
 return executeTransfer(c,command);
}
export type TransferScreenScope={userId:string;staffList?:boolean;visits:Array<{id:string;version:number;side:'client'|'staff'}>};
export async function transferScreenAllowed(tx:Tx,chatId:string,scope:TransferScreenScope):Promise<boolean>{
 if(!(await tx.query('SELECT id FROM telegram_users WHERE id=$1 AND telegram_id=$2',[scope.userId,chatId])).length)return false;
 if(scope.staffList){const roles=await tx.query<{role:string}>('SELECT role FROM roles WHERE user_id=$1',[scope.userId]);if(!roles.some(r=>r.role==='admin'||r.role==='barber'))return false;}
 for(const item of scope.visits){
  let v:Visit;try{v=await visitFor({tx,userId:scope.userId,updateId:null},item.id);}catch(e){if(e instanceof DomainError)return false;throw e;}
  if(v.version!==item.version||v.status!=='confirmed'||!v.barber_active||Date.parse(stamp(v.start_at))<=Date.parse(tx.now))return false;
  if(item.side==='client'?!client(v,scope.userId,v.actor_roles):!staff(v,scope.userId,v.actor_roles)||v.client_user_id===scope.userId)return false;
 }
 return true;
}
export async function prepareTransferCard(tx:Tx,id:string,version:number,userId:string,chatId:string,ids:unknown,notice?:unknown){
 if(!(await tx.query('SELECT id FROM telegram_users WHERE id=$1 AND telegram_id=$2',[userId,chatId])).length)return null;
 const t=(await tx.query<Transfer>('SELECT * FROM transfers WHERE id=$1',[id]))[0];if(!t||t.version!==version||!t.context||!t.initiator_user_id)return null;
 const v=await visitFor({tx,userId,updateId:null},t.visit_id,t.initiator_user_id);
 if(userId===t.initiator_user_id?!authorAllowed(t,v):!client(v,userId,v.actor_roles)&&!staff(v,userId,v.actor_roles))return null;
 if(t.status==='pending'&&(!matches(t,v)||!authorAllowed(t,v)||Date.parse(stamp(t.deadline))<=Date.parse(tx.now)))return null;
 // Terminal cards describe the current scheduling outcome, not a historical event.
 // Ownership-only changes may increment visit.version without changing this outcome.
 if(t.status!=='pending'){
  const accepted=t.status==='accepted',generation=t.context.scheduleGeneration+(accepted?1:0);
  const start=accepted?stamp(t.new_start_at):t.context.oldStart,end=accepted?stamp(t.new_end_at):t.context.oldEnd;
  const currentStatus=v.status==='confirmed'||t.status==='cancelled'&&v.status==='cancelled';
  if(!currentStatus||v.barber_id!==t.context.barberId||v.schedule_generation!==generation||stamp(v.start_at)!==start||stamp(v.end_at)!==end)return null;
 }
 const rows=Array.isArray(ids)&&ids.length?await tx.query<{id:string;action:string}>(`SELECT id,action FROM transfer_callbacks WHERE id=ANY($1::uuid[]) AND transfer_id=$2 AND user_id=$3 AND transfer_version=$4 AND consumed_at IS NULL AND expires_at>$5`,[ids,t.id,userId,t.version,tx.now]):[];
 if(Array.isArray(ids)&&rows.length!==ids.length)return null;
 if(rows.some(r=>!approver(t,v,userId,v.actor_roles,r.action==='phone')))return null;
 const labels:Record<string,string>={pending:'Перенос ожидает согласия.',accepted:'Перенос принят.',declined:'Перенос отклонён. Старое время сохранено.',expired:'Срок согласия истёк. Старое время сохранено.',cancelled:'Перенос отменён.'};
 const fmt=(s:Date|string)=>new Date(s).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'});
 const clip=(s:string,n:number)=>s.length>n?s.slice(0,n-1).replace(/[\uD800-\uDBFF]$/,'')+'…':s;
 const text=`${labels[t.status]}\nМастер: ${clip(v.barber,120)}\nБыло: ${fmt(t.context.oldStart)} (МСК)\nПредложено: ${fmt(t.new_start_at)} (МСК)\n${clip(v.items.map(i=>i.name).join(', '),1500)}\nСтоимость: ${v.items.reduce((n,i)=>n+i.priceKopecks,0)/100} ₽\nДлительность: ${v.items.reduce((n,i)=>n+i.durationMinutes,0)} мин.\nОтвет до: ${fmt(t.deadline)} (МСК)${t.reason?'\nПричина: '+t.reason:''}${typeof notice==='string'?'\n'+clip(notice,500):''}`;
 return {text,keyboard:rows.length?{inline_keyboard:[rows.map(b=>({text:b.action==='accept'?'Принять':b.action==='phone'?'Согласовано с клиентом':'Отклонить',callback_data:b.id}))]}:undefined};
}
