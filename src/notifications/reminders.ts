import type { Tx } from '../db/client';
import { DomainError, type Id, type Instant } from '../domain/types';
import { remainingReminders,validateReminderHours,type ReminderHours } from './planner';
type Context={tx:Tx;userId:Id|null;updateId:Id|null};
type Existing={id:string;logical_key:string;status:string;sent_at:string|null;entity_version:number;payload:{reminderKind?:string;scheduledStart?:string;scheduledDueAt?:string};due_at:string};
type Visit={id:string;version:number;start_at:string|Date;chat_id:string;reminder_hours:ReminderHours;confirmed_at:string|Date|null;reminders:Existing[]};
const stamp=(v:Date|string)=>new Date(v).toISOString();
// Both callers and delivery run under the shop lock. No send or scheduler call belongs here.
export async function reconcileReminders(c:Context,options:{visitId?:Id;confirmedAt?:Instant;mode?:'ensure'|'preference'}={}):Promise<void>{
  const visits=await c.tx.query<Visit>(`SELECT v.id,v.version,v.start_at,u.telegram_id::text AS chat_id,c.reminder_hours,
    (SELECT max(a.created_at) FROM audit_events a WHERE a.entity_id=v.id AND a.kind='visit_confirmed') AS confirmed_at,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',o.id,'logical_key',o.logical_key,'status',o.status,
      'sent_at',o.sent_at,'entity_version',o.entity_version,'payload',o.payload,'due_at',o.due_at))
      FROM outbox o WHERE o.entity_id=v.id AND o.kind='reminder'),'[]'::jsonb) AS reminders
    FROM visits v JOIN clients c ON c.id=v.client_id JOIN telegram_users u ON u.id=c.user_id
    WHERE v.status='confirmed' AND v.start_at>$1 AND ($2::uuid IS NULL OR c.user_id=$2)
      AND ($3::uuid IS NULL OR v.id=$3)`,[c.tx.now,c.userId,options.visitId??null]);
  const cancelled:string[]=[],desired:Array<Record<string,unknown>>=[];
  for(const v of visits){
    const start=stamp(v.start_at),history=v.reminders;
    const plans=remainingReminders({visitId:v.id,version:v.version,start,now:c.tx.now,hours:v.reminder_hours,
      ...(options.confirmedAt?{confirmedAt:options.confirmedAt}:v.confirmed_at?{confirmedAt:stamp(v.confirmed_at)}:{})});
    const terminal=new Set(history.filter(r=>(r.status==='sent'||r.sent_at!==null)&&r.payload.scheduledStart&&Date.parse(r.payload.scheduledStart)===Date.parse(start)).map(r=>r.payload.reminderKind));
    const candidates=plans.filter(p=>!terminal.has(p.kind));
    for(const r of history){
      if(r.status==='sent'||r.sent_at!==null||!['pending','leased'].includes(r.status))continue;
      if(r.entity_version!==v.version||(options.mode==='preference'&&!candidates.some(p=>p.key===r.logical_key)))cancelled.push(r.id);
    }
    for(const p of candidates){
      const current=history.find(r=>r.logical_key===p.key);
      if(current){
        if(current.status==='sent'||current.sent_at!==null||current.status==='failed')continue;
        if(options.mode!=='preference')continue;
        if(['pending','leased'].includes(current.status)&&Date.parse(current.payload.scheduledDueAt??current.due_at)===Date.parse(p.dueAt))continue;
      }
      desired.push({key:p.key,visitId:v.id,version:v.version,chatId:v.chat_id,dueAt:p.dueAt,payload:{text:`Напоминание о записи: ${new Date(start).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} (МСК).`,reminderKind:p.kind,scheduledStart:start,scheduledDueAt:p.dueAt}});
    }
  }
  // A no-op never steals leases, resets retries, or writes rows.
  if(!cancelled.length&&!desired.length)return;
  await c.tx.query(`WITH cancelled AS (
    UPDATE outbox SET status='cancelled',claim_token=NULL,lease_until=NULL,version=version+1
    WHERE id=ANY($1::uuid[]) AND status IN ('pending','leased') AND sent_at IS NULL
  ) INSERT INTO outbox(logical_key,update_id,kind,chat_id,payload,due_at,entity_id,entity_version,entity_type)
    SELECT x.key,$3,'reminder',x."chatId"::bigint,x.payload,x."dueAt",x."visitId",x.version,'visit'
    FROM jsonb_to_recordset($2::jsonb) AS x(key text,"chatId" text,payload jsonb,"dueAt" timestamptz,"visitId" uuid,version integer)
    JOIN visits v ON v.id=x."visitId" AND v.version=x.version AND v.status='confirmed' AND v.start_at>$4
    JOIN clients c ON c.id=v.client_id JOIN telegram_users u ON u.id=c.user_id AND u.telegram_id=x."chatId"::bigint
    ON CONFLICT(logical_key) DO UPDATE SET due_at=EXCLUDED.due_at,payload=EXCLUDED.payload,
      chat_id=EXCLUDED.chat_id,status='pending',claim_token=NULL,lease_until=NULL,version=outbox.version+1
    WHERE outbox.status IN ('pending','leased','cancelled') AND outbox.sent_at IS NULL
      AND (outbox.status='cancelled' OR outbox.payload IS DISTINCT FROM EXCLUDED.payload OR outbox.chat_id<>EXCLUDED.chat_id)`,[cancelled,JSON.stringify(desired),c.updateId,c.tx.now]);
}
export async function setReminderHours(c:Context,hours:number):Promise<void>{
  validateReminderHours(hours);
  if(!c.userId)throw new DomainError('forbidden','Настройки недоступны.');
  const row=(await c.tx.query<{reminder_hours:number}>('SELECT reminder_hours FROM clients WHERE user_id=$1',[c.userId]))[0];
  if(!row)throw new DomainError('profile_required','Откройте /start.');
  const changed=row.reminder_hours!==hours;
  if(changed)await c.tx.query('UPDATE clients SET reminder_hours=$2,version=version+1 WHERE user_id=$1',[c.userId,hours]);
  await reconcileReminders(c,{mode:changed?'preference':'ensure'});
}
