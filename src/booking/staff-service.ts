import type {Context} from './service';
import {event,nextDue} from './service';
import {DomainError,type StaffCommand} from '../domain/types';
import {isMeaningfulName,normalizePhone} from '../identity/service';
import {prepareAvailability} from '../schedule/service';
import {reviewedQuote} from './quote';
import {reconcileReminders} from '../notifications/reminders';
import {closeTransferWork} from './transfers';
import {staffReason} from '../reports/input';
const refuse=(code:string):never=>{throw new DomainError(code,'Действие недоступно. Обновите форму через /start.');};
export async function staffAuthority(c:Context,barberId?:string,historical=false){
 const row=(await c.tx.query<{admin:boolean;own:string|null;active:boolean;barber:boolean}>(`SELECT
  EXISTS(SELECT 1 FROM roles WHERE user_id=$1 AND role='admin') AS admin,
  EXISTS(SELECT 1 FROM roles WHERE user_id=$1 AND role='barber') AS barber,
  b.id AS own,b.archived_at IS NULL AS active FROM telegram_users u LEFT JOIN barbers b ON b.user_id=u.id WHERE u.id=$1`,[c.userId]))[0];
 if(!row||(!row.admin&&(!row.barber||!row.own||(!historical&&!row.active)||(barberId!==undefined&&row.own!==barberId))))refuse('forbidden');
 return row!;
}
export function isStaffCommand(command:{kind:string}):command is StaffCommand{return ['createManualBooking','staffCancelBooking','markOutcome','correctOutcome'].includes(command.kind);}
export async function prepareManual(c:Context,command:Extract<StaffCommand,{kind:'createManualBooking'}>){
 await staffAuthority(c,command.barberId);
 if(typeof command.clientName!=='string'||!isMeaningfulName(command.clientName))refuse('invalid_name');
 const phone=normalizePhone(command.phone),enteredName=command.clientName.trim();
 const claims=await c.tx.query<{id:string;client_id:string;user_id:string;current_user:string|null;current_phone:string|null;name:string}>(`SELECT p.id,p.client_id,p.user_id,c.user_id AS current_user,c.phone AS current_phone,c.name FROM phone_claims p LEFT JOIN clients c ON c.id=p.client_id WHERE p.phone=$1 AND p.released_at IS NULL`,[phone]);
 const claim=claims[0];
 if(claim&&(claim.current_user!==claim.user_id||claim.current_phone!==phone))refuse('identity_conflict');
 const name=claim?.name.trim()||enteredName;
 if(!isMeaningfulName(name))refuse('invalid_name');
 const unlinked=!claim?(await c.tx.query<{id:string}>(`SELECT id FROM clients WHERE user_id IS NULL AND phone=$1 AND trim(name)=$2 ORDER BY id LIMIT 1`,[phone,enteredName]))[0]:undefined;
 if(!Number.isFinite(Date.parse(command.start)))refuse('slot_unavailable');
 const start=new Date(command.start).toISOString(),input={barberId:command.barberId,serviceIds:command.serviceIds,from:start,to:start,actorMode:'staff' as const};
 const availability=await prepareAvailability(input,c.tx),slot=availability.slots(input).find(s=>s.start===start);
 if(!slot)refuse('slot_unavailable');
 const quote=await reviewedQuote(command.barberId,command.serviceIds,availability.offer,c.tx);
 const clientId=claim?.client_id??unlinked?.id??null;
 return {...quote,masterName:quote.name,start,slot:slot!,name,phone,clientId,canonical:!!claim,manualClientName:claim&&!claim.name.trim()?enteredName:undefined,
  fingerprint:JSON.stringify({quote:quote.fingerprint,start,name,phone,clientId,claim:claim??null})};
}
export async function executeStaff(c:Context,command:StaffCommand,expectedQuote?:string){
 const {tx,userId,updateId}=c;
 if(command.kind==='createManualBooking'){
  if(expectedQuote!==undefined&&typeof expectedQuote!=='string')refuse('quote_conflict');
  const q=await prepareManual(c,command);
  if(command.clientName.trim()!==q.name||expectedQuote!==undefined&&q.fingerprint!==expectedQuote)refuse('quote_conflict');
  const client=q.clientId??(await tx.query<{id:string}>('INSERT INTO clients(name,phone) VALUES($1,$2) RETURNING id',[q.name,q.phone]))[0].id;
  const v=(await tx.query<{id:string}>(`INSERT INTO visits(client_id,barber_id,status,start_at,end_at,created_at) VALUES($1,$2,'confirmed',$3,$4,$5) RETURNING id`,[client,command.barberId,q.start,q.slot.end,tx.now]))[0];
  await tx.query(`INSERT INTO visit_items(visit_id,service_id,name,price_kopecks,duration_minutes) SELECT $1,x."serviceId",x.name,x."priceKopecks",x."durationMinutes" FROM jsonb_to_recordset($2::jsonb) AS x("serviceId" uuid,name text,"priceKopecks" integer,"durationMinutes" integer)`,[v.id,JSON.stringify(q.offer.items)]);
  await tx.query("INSERT INTO holds(visit_id,barber_id,kind,start_at,end_at) VALUES($1,$2,'visit',$3,$4)",[v.id,command.barberId,q.start,q.slot.end]);
  await event(c,'visit_confirmed',v.id,v.id);
  if(q.manualClientName)await tx.query("UPDATE audit_events SET data=data||jsonb_build_object('manualClientName',$2::text) WHERE entity_id=$1 AND kind='visit_confirmed' AND update_id=$3",[v.id,q.manualClientName,updateId]);
  await reconcileReminders({...c,userId:null},{visitId:v.id,confirmedAt:tx.now});
  return {entityId:v.id,status:'confirmed',nextWake:await nextDue(tx)};
 }
 // Permission is checked before loading any customer details. Only barber id/status metadata is read here.
 const access=await staffAuthority(c);
 const v=(await tx.query<{id:string;barber_id:string;version:number;status:string;start_at:string|Date}>('SELECT id,barber_id,version,status,start_at FROM visits WHERE id::text=$1',[command.visitId]))[0];
 if(!v)refuse('not_found');
 if(command.kind==='correctOutcome'){if(!access.admin)refuse('forbidden');}
 else await staffAuthority(c,v!.barber_id);
 if(!Number.isInteger(command.expectedVersion)||command.expectedVersion<=0||v!.version!==command.expectedVersion)refuse('stale_version');
 let reason:string|undefined,status:string;
 if(command.kind==='staffCancelBooking'){
  reason=staffReason(command.reason);if(!['pending','confirmed'].includes(v!.status))refuse('invalid_state');status='cancelled';
 }else{
  if(!['completed','no_show'].includes(command.outcome))refuse('invalid_input');
  if(command.kind==='markOutcome'){
   if(v!.status!=='confirmed')refuse('invalid_state');if(Date.parse(new Date(v!.start_at).toISOString())>Date.parse(tx.now))refuse('not_started');
  }else{reason=staffReason(command.reason);if(!['completed','no_show'].includes(v!.status)||v!.status===command.outcome)refuse('invalid_state');}
  status=command.outcome;
 }
 await closeStaffVisitWork(c,v!.id,status==='cancelled');
 await tx.query('UPDATE visits SET status=$1,version=version+1 WHERE id=$2',[status,v!.id]);
 if(status==='cancelled')await event(c,'visit_cancelled',v!.id,v!.id,reason);
 else await tx.query(`INSERT INTO audit_events(update_id,actor_id,kind,entity_id,data,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,[updateId,userId,command.kind==='correctOutcome'?'visit_outcome_corrected':'visit_outcome_marked',v!.id,JSON.stringify({oldOutcome:v!.status,newOutcome:status,...(reason?{reason}:{})}),tx.now]);
 return {entityId:v!.id,status,nextWake:await nextDue(tx)};
}
export async function closeStaffVisitWork(c:Context,visitId:string,notifyTransfers=false){
 const {tx}=c;
 const transfers=await tx.query<{id:string}>("UPDATE transfers SET status='cancelled',version=version+1 WHERE visit_id=$1 AND status='pending' RETURNING id",[visitId]);
 for(const t of transfers){
  if(notifyTransfers)await event(c,'transfer_cancelled',t.id,visitId);
  else{await closeTransferWork(tx,t.id);await tx.query("INSERT INTO audit_events(update_id,actor_id,kind,entity_id,data,created_at) VALUES($1,$2,'transfer_cancelled',$3,jsonb_build_object('visitId',$4::text),$5)",[c.updateId,c.userId,t.id,visitId,tx.now]);}
 }
 await tx.query('DELETE FROM holds WHERE visit_id=$1',[visitId]);
 await tx.query("UPDATE jobs SET status='cancelled',lease_until=NULL,version=version+1 WHERE visit_id=$1 AND status IN ('pending','leased')",[visitId]);
 await tx.query("UPDATE outbox SET status='cancelled',claim_token=NULL,lease_until=NULL,version=version+1 WHERE (entity_id=$1 OR ($2=false AND entity_id IN(SELECT id FROM transfers WHERE visit_id=$1))) AND status IN ('pending','leased')",[visitId,notifyTransfers]);
 await tx.query('UPDATE staff_callbacks SET consumed_at=COALESCE(consumed_at,$2) WHERE visit_id=$1',[visitId,tx.now]);
}
