import type {Context} from '../booking/service';
import {executeBooking} from '../booking/service';
import type {Actor,CommandResult} from '../domain/types';
import {DomainError} from '../domain/types';
import type {Tx} from '../db/client';
import {createClientController} from './client';
import {handleTransferCallback} from '../booking/transfers';
import {queueStaffDecision,staffVisit} from './staff';

export async function prepareCancellationEntry(tx:Tx,visitId:string,version:number,chatId:string){
 const rows=await tx.query<{id:string}>(`INSERT INTO entry_callbacks(user_id,visit_id,visit_version,action,expires_at)
 SELECT c.user_id,v.id,v.version,'new_booking',$4::timestamptz+interval '30 minutes'
 FROM visits v JOIN clients c ON c.id=v.client_id JOIN telegram_users u ON u.id=c.user_id
 WHERE v.id=$1 AND v.version=$2 AND v.status='cancelled' AND u.telegram_id=$3 RETURNING id`,[visitId,version,chatId,tx.now]);
 return rows[0]?{inline_keyboard:[[{text:'Новая запись',callback_data:rows[0].id}]]}:undefined;
}
export async function handleIndependentEntry(c:Context,actor:Actor,callbackId:string):Promise<CommandResult|null>{
 const {tx,userId}=c;
 const entry=(await tx.query<{user_id:string;visit_id:string;visit_version:number;version:number;action:string;expires_at:Date|string;consumed_at:unknown}>('SELECT * FROM entry_callbacks WHERE id::text=$1',[callbackId]))[0];
 if(entry){
  if(entry.user_id!==userId)throw new DomainError('forbidden','Кнопка предназначена другому пользователю.');
  const valid=await tx.query(`SELECT v.id FROM visits v JOIN clients c ON c.id=v.client_id JOIN telegram_users u ON u.id=c.user_id WHERE v.id=$1 AND v.version=$2 AND v.status='cancelled' AND c.user_id=$3 AND u.telegram_id=$4`,[entry.visit_id,entry.visit_version,userId,actor.telegramId]);
  if(!valid.length||entry.version!==1||entry.action!=='new_booking'||entry.consumed_at||Date.parse(new Date(entry.expires_at).toISOString())<=Date.parse(tx.now))throw new DomainError('stale_callback','Кнопка устарела. Откройте /start для новой записи.');
  await tx.query('UPDATE entry_callbacks SET consumed_at=$2,version=version+1 WHERE id::text=$1',[callbackId,tx.now]);
  await tx.query("INSERT INTO roles(user_id,role) VALUES($1,'client') ON CONFLICT(user_id,role) DO NOTHING",[userId]);
  return createClientController(c,actor).start(null);
 }
 const transfer=await handleTransferCallback(c,callbackId);if(transfer)return transfer;
 const staff=(await tx.query<{user_id:string;visit_id:string;visit_version:number;action:'confirmBooking'|'declineBooking';expires_at:Date|string;consumed_at:unknown}>('SELECT * FROM staff_callbacks WHERE id::text=$1',[callbackId]))[0];
 if(!staff)return null;
 if(staff.user_id!==userId)throw new DomainError('forbidden','Кнопка предназначена другому пользователю.');
 const visit=await staffVisit(tx,staff.visit_id,userId!);if(!visit)throw new DomainError('forbidden','Заявка недоступна.');
 if(staff.consumed_at||staff.visit_version!==visit.version||Date.parse(new Date(staff.expires_at).toISOString())<=Date.parse(tx.now)){await queueStaffDecision(c,staff.visit_id,userId!);return {status:'stale_callback',nextWake:tx.now};}
 await tx.query('UPDATE staff_callbacks SET consumed_at=$2 WHERE id::text=$1',[callbackId,tx.now]);
 return executeBooking(c,{kind:staff.action,visitId:staff.visit_id,expectedVersion:staff.visit_version});
}
