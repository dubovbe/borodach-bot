import {DomainError,type AdminCommand,type CommandResult,type WorkSchedule,type Conflict} from '../domain/types';
import type {Context} from '../booking/service';
import {nextDue} from '../booking/service';
import {isMeaningfulName,hashToken,publicBookingToken,type IdentityOptions} from '../identity/service';
import {loadSchedule,validateSchedule,validateScheduleChange,liveScheduleIntervals} from '../schedule/service';
const kinds=new Set(['saveService','archiveService','saveRank','archiveRank','saveBarber','archiveBarber','setRankTariff','setBarberTariff','assignBarberService','saveWeeklyHours','saveDateException','setBookingHorizon','issuePublicLink','showPublicLink']);
export const isAdminCommand=(command:{kind:string}):command is AdminCommand=>kinds.has(command.kind);
const refuse=(code:string):never=>{throw new DomainError(code,code==='public_link_legacy'?'Эта ссылка создана ранее и недоступна для показа. Выберите создание с заменой предыдущей ссылки.':'Действие недоступно. Проверьте данные и обновите форму.');};
const version=(value:unknown)=>{if(!Number.isInteger(value)||Number(value)<1)refuse('invalid_input');};
const tariff=(price:number,minutes:number)=>{if(!Number.isInteger(price)||price<0||price>2147483647||!Number.isInteger(minutes)||minutes<1||minutes>2147483647)refuse('invalid_input');};
export async function requireAdmin(c:Context){const roles=await c.tx.query<{role:string}>('SELECT role FROM roles WHERE user_id=$1',[c.userId]);if(!roles.some(r=>r.role==='admin'))refuse('forbidden');}
type Entity={id:string;version:number;name:string;rank_id?:string|null;public_token_hash?:string|null};
export async function activeEntity(c:Context,table:'services'|'ranks'|'barbers',id:string,expected?:number){
 const row=(await c.tx.query<Entity>(`SELECT * FROM ${table} WHERE id::text=$1 AND archived_at IS NULL`,[id]))[0];if(!row)return refuse('not_found');if(expected!==undefined){version(expected);if(row.version!==expected)refuse('stale_version');}return row;
}
async function record(c:Context,kind:string,id:string|null){
 await c.tx.query(`WITH audit AS (INSERT INTO audit_events(update_id,actor_id,kind,entity_id,created_at) VALUES($1,$2,$3,$4,$5))
 INSERT INTO outbox(logical_key,update_id,kind,chat_id,payload,due_at) SELECT $6,$1,'start',telegram_id,$7::jsonb,$5 FROM telegram_users WHERE id=$2`,[c.updateId,c.userId,kind,id,c.tx.now,`admin-result:${c.updateId}`,JSON.stringify({text:'Изменения сохранены.'})]);
}
async function conflictResult(c:Context,status:'schedule_conflict'|'barber_conflict',conflicts:Conflict[]):Promise<CommandResult>{
 await c.tx.query(`INSERT INTO outbox(logical_key,update_id,kind,chat_id,payload,due_at) SELECT $1,$2,'start',telegram_id,$3::jsonb,$4 FROM telegram_users WHERE id=$5`,[`admin-conflict:${c.updateId}`,c.updateId,JSON.stringify({text:'Изменения не сохранены: есть действующие записи или переносы. Проверьте список конфликтов в управлении.'}),c.tx.now,c.userId]);
 return {status,conflicts,nextWake:c.tx.now};
}
export async function saveSchedule(c:Context,barberId:string,expectedVersion:number,schedule:WorkSchedule,scope?:{weekday:number}|{date:string}):Promise<CommandResult>{
 await requireAdmin(c);version(expectedVersion);await activeEntity(c,'barbers',barberId,expectedVersion);return applySchedule(c,barberId,schedule,scope);
}
async function applySchedule(c:Context,barberId:string,schedule:WorkSchedule,scope?:{weekday:number}|{date:string}):Promise<CommandResult>{
 validateSchedule(schedule);
 const conflicts=await validateScheduleChange(barberId,schedule,c.tx);if(conflicts.length)return conflictResult(c,'schedule_conflict',conflicts);
 const weekly=Object.entries(schedule.weekly).flatMap(([weekday,intervals])=>intervals.map(i=>({weekday:Number(weekday),start_minute:i.startMinute,end_minute:i.endMinute})));
 const exceptions=Object.entries(schedule.exceptions).map(([local_date,intervals])=>({local_date,intervals}));
 if(scope&&'weekday' in scope){
  await c.tx.query(`WITH removed AS (DELETE FROM weekly_hours WHERE barber_id=$1 AND weekday=$2 RETURNING id), inserted AS (
   INSERT INTO weekly_hours(barber_id,weekday,start_minute,end_minute) SELECT $1,$2,x.start_minute,x.end_minute FROM jsonb_to_recordset($3::jsonb) x(start_minute integer,end_minute integer) WHERE (SELECT count(*) FROM removed)>=0)
   UPDATE barbers SET version=version+1 WHERE id=$1`,[barberId,scope.weekday,JSON.stringify(weekly.filter(x=>x.weekday===scope.weekday))]);
 }else if(scope&&'date' in scope){
  const value=schedule.exceptions[scope.date];
  await c.tx.query(value===undefined?`WITH removed AS (DELETE FROM date_exceptions WHERE barber_id=$1 AND local_date=$2) UPDATE barbers SET version=version+1 WHERE id=$1`:
   `WITH saved AS (INSERT INTO date_exceptions(barber_id,local_date,intervals) VALUES($1,$2,$3::jsonb) ON CONFLICT(barber_id,local_date) DO UPDATE SET intervals=EXCLUDED.intervals,version=date_exceptions.version+1) UPDATE barbers SET version=version+1 WHERE id=$1`,value===undefined?[barberId,scope.date]:[barberId,scope.date,JSON.stringify(value)]);
 }else{
 await c.tx.query(`WITH old_weekly AS (DELETE FROM weekly_hours WHERE barber_id=$1 RETURNING id), old_exceptions AS (DELETE FROM date_exceptions WHERE barber_id=$1 RETURNING id),
 weekly AS (INSERT INTO weekly_hours(barber_id,weekday,start_minute,end_minute) SELECT $1,x.weekday,x.start_minute,x.end_minute FROM jsonb_to_recordset($2::jsonb) x(weekday integer,start_minute integer,end_minute integer) WHERE (SELECT count(*) FROM old_weekly)>=0),
 exceptions AS (INSERT INTO date_exceptions(barber_id,local_date,intervals) SELECT $1,x.local_date,x.intervals FROM jsonb_to_recordset($3::jsonb) x(local_date date,intervals jsonb) WHERE (SELECT count(*) FROM old_exceptions)>=0)
 UPDATE barbers SET version=version+1 WHERE id=$1`,[barberId,JSON.stringify(weekly),JSON.stringify(exceptions)]);
 }
 await record(c,'schedule_changed',barberId);return {entityId:barberId,status:'schedule_changed',nextWake:await nextDue(c.tx)};
}
export async function executeAdmin(c:Context,command:AdminCommand,options:IdentityOptions={}):Promise<CommandResult>{
 await requireAdmin(c);const {tx}=c;let id:string|null=null;
 if(command.kind!=='saveService'&&command.kind!=='saveRank'&&command.kind!=='saveBarber')version(command.expectedVersion);
 if(command.kind==='saveService'||command.kind==='saveRank'||command.kind==='saveBarber'){
  const table=command.kind==='saveService'?'services':command.kind==='saveRank'?'ranks':'barbers';id=command.kind==='saveService'?command.serviceId:command.kind==='saveRank'?command.rankId:command.barberId;
  if(typeof command.name!=='string'||!isMeaningfulName(command.name))refuse('invalid_input');
  if(id===null){if(command.expectedVersion!==null)refuse('invalid_input');}else await activeEntity(c,table,id,command.expectedVersion??0);
  if(command.kind==='saveBarber'&&command.rankId!==null)await activeEntity(c,'ranks',command.rankId);
  const rows=await tx.query<{id:string}>(id===null?(table==='barbers'?'INSERT INTO barbers(name,rank_id) VALUES($1,$2) RETURNING id':`INSERT INTO ${table}(name) VALUES($1) RETURNING id`):(table==='barbers'?'UPDATE barbers SET name=$1,rank_id=$2,version=version+1 WHERE id=$3 RETURNING id':`UPDATE ${table} SET name=$1,version=version+1 WHERE id=$2 RETURNING id`),table==='barbers'?[command.name.trim(),(command as Extract<AdminCommand,{kind:'saveBarber'}>).rankId,...(id===null?[]:[id])]:[command.name.trim(),...(id===null?[]:[id])]);id=rows[0].id;
 }else if(command.kind==='archiveService'||command.kind==='archiveRank'||command.kind==='archiveBarber'){
  const table=command.kind==='archiveService'?'services':command.kind==='archiveRank'?'ranks':'barbers';id=command.kind==='archiveService'?command.serviceId:command.kind==='archiveRank'?command.rankId:command.barberId;await activeEntity(c,table,id,command.expectedVersion);
  if(command.kind==='archiveRank'&&(await tx.query('SELECT id FROM barbers WHERE rank_id=$1 AND archived_at IS NULL LIMIT 1',[id])).length)refuse('rank_in_use');
  if(command.kind==='archiveBarber'){
   const conflicts=await liveScheduleIntervals(id,tx);if(conflicts.length)return conflictResult(c,'barber_conflict',conflicts);
   await tx.query(`WITH revoked AS (UPDATE invitations SET revoked_at=$2,version=version+1 WHERE barber_id=$1 AND used_at IS NULL AND revoked_at IS NULL RETURNING id)
 UPDATE outbox SET status='cancelled',claim_token=NULL,lease_until=NULL,version=version+1 WHERE kind='invitation' AND status IN ('pending','leased') AND payload->>'invitationId' IN(SELECT id::text FROM revoked)`,[id,tx.now]);
  }
  await tx.query(`UPDATE ${table} SET archived_at=$2,version=version+1 WHERE id=$1`,[id,tx.now]);
 }else if(command.kind==='setRankTariff'||command.kind==='setBarberTariff'||command.kind==='assignBarberService'){
  const rank=command.kind==='setRankTariff';id=rank?command.rankId:command.barberId;const table=rank?'ranks':'barbers';await activeEntity(c,table,id,command.expectedVersion);await activeEntity(c,'services',command.serviceId);
  if(command.kind==='assignBarberService'){
   if(typeof command.assigned!=='boolean')refuse('invalid_input');
   await tx.query(command.assigned?'INSERT INTO assignments(barber_id,service_id) VALUES($1,$2) ON CONFLICT(barber_id,service_id) DO UPDATE SET version=assignments.version+1':'DELETE FROM assignments WHERE barber_id=$1 AND service_id=$2',[id,command.serviceId]);
  }else if(command.kind==='setBarberTariff'&&command.operation==='reset')await tx.query('DELETE FROM barber_tariffs WHERE barber_id=$1 AND service_id=$2',[id,command.serviceId]);
  else {
   if(command.kind==='setBarberTariff'&&command.operation!=='set')refuse('invalid_input');
   const set=command as Extract<AdminCommand,{kind:'setRankTariff'}>|(Extract<AdminCommand,{kind:'setBarberTariff'}>&{operation:'set'});tariff(set.priceKopecks,set.durationMinutes);
   const tariffs=rank?'rank_tariffs':'barber_tariffs',owner=rank?'rank_id':'barber_id';
   await tx.query(`INSERT INTO ${tariffs}(${owner},service_id,price_kopecks,duration_minutes) VALUES($1,$2,$3,$4) ON CONFLICT(${owner},service_id) DO UPDATE SET price_kopecks=EXCLUDED.price_kopecks,duration_minutes=EXCLUDED.duration_minutes,version=${tariffs}.version+1`,[id,command.serviceId,set.priceKopecks,set.durationMinutes]);
  }
  await tx.query(`UPDATE ${table} SET version=version+1 WHERE id=$1`,[id]);
 }else if(command.kind==='saveWeeklyHours'||command.kind==='saveDateException'){
  await activeEntity(c,'barbers',command.barberId,command.expectedVersion);const schedule=await loadSchedule(command.barberId,tx);
  if(command.kind==='saveWeeklyHours'){if(!Number.isInteger(command.weekday)||command.weekday<1||command.weekday>7)refuse('invalid_input');schedule.weekly[command.weekday]=command.intervals;}
  else {if(!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(command.date)||!Number.isFinite(Date.parse(command.date))||new Date(command.date).toISOString().slice(0,10)!==command.date)refuse('invalid_input');if(command.intervals===null)delete schedule.exceptions[command.date];else schedule.exceptions[command.date]=command.intervals;}
  return applySchedule(c,command.barberId,schedule,command.kind==='saveWeeklyHours'?{weekday:command.weekday}:{date:command.date});
 }else if(command.kind==='setBookingHorizon'){
  version(command.expectedVersion);if(!Number.isInteger(command.days)||command.days<1||command.days>365)refuse('invalid_input');
  const result=await tx.query<{id:string}>('UPDATE settings SET booking_horizon_days=$1,version=version+1 WHERE shop_id=1 AND version=$2 RETURNING id',[command.days,command.expectedVersion]);if(!result.length)refuse('stale_version');id=result[0].id;
 }else if(command.kind==='issuePublicLink'||command.kind==='showPublicLink'){
  const barber=await activeEntity(c,'barbers',command.barberId,command.expectedVersion);id=barber.id;
  if(!options.botUsername||!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(options.botUsername))refuse('invitation_unconfigured');
  const hash=await hashToken(await publicBookingToken(id,options.invitationSecret));
  if(command.kind==='showPublicLink'&&barber.public_token_hash!==hash)refuse('public_link_legacy');
  if(command.kind==='issuePublicLink'){
   if(barber.public_token_hash&&barber.public_token_hash!==hash&&!command.replace)refuse('public_link_legacy');
   await tx.query('UPDATE barbers SET public_token_hash=$2,version=version+1 WHERE id=$1',[id,hash]);
  }
  await tx.query(`INSERT INTO outbox(logical_key,update_id,kind,chat_id,payload,due_at) SELECT $1,$2,'public_link',telegram_id,$3::jsonb,$4 FROM telegram_users WHERE id=$5`,[`public-link:${c.updateId}`,c.updateId,JSON.stringify({barberId:id}),tx.now,c.userId]);
 }else return refuse('forbidden');
 await record(c,command.kind,id);return {entityId:id??undefined,status:'saved',nextWake:await nextDue(tx)};
}
