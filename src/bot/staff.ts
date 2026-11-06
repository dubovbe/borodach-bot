import type { Tx } from '../db/client';
import type { Context } from '../booking/service';
import type { InlineKeyboardMarkup } from 'grammy/types';
const stamp=(v:Date|string)=>new Date(v).toISOString();
export async function staffVisit(tx:Tx,visitId:string,userId:string){
  return (await tx.query<{id:string;version:number;deadline:Date|string;name:string;phone:string;barber:string;start_at:Date|string;items:Array<{name:string;price:number;duration:number}>}>(`SELECT v.id,v.version,v.deadline,c.name,c.phone,b.name AS barber,v.start_at,
    (SELECT jsonb_agg(jsonb_build_object('name',i.name,'price',i.price_kopecks,'duration',i.duration_minutes) ORDER BY i.id) FROM visit_items i WHERE i.visit_id=v.id) AS items
    FROM visits v JOIN clients c ON c.id=v.client_id JOIN barbers b ON b.id=v.barber_id
    WHERE v.id=$1 AND v.status='pending' AND v.deadline>$3 AND
      (EXISTS(SELECT 1 FROM roles WHERE user_id=$2 AND role='admin') OR
       (b.user_id=$2 AND b.archived_at IS NULL AND EXISTS(SELECT 1 FROM roles WHERE user_id=$2 AND role='barber')))`,[visitId,userId,tx.now]))[0];
}
export async function queueStaffDecision(c:Context,visitId:string,userId?:string):Promise<void>{
  const recipients=await c.tx.query<{id:string;telegram_id:string}>(`SELECT u.id,u.telegram_id::text FROM visits v JOIN barbers b ON b.id=v.barber_id JOIN telegram_users u ON u.id=b.user_id WHERE v.id=$1 AND ($2::uuid IS NULL OR u.id=$2)`,[visitId,userId??null]);
  for(const r of recipients){
    const v=await staffVisit(c.tx,visitId,r.id);if(!v)continue;
    const buttons=['confirmBooking','declineBooking'].map(action=>({id:crypto.randomUUID(),action}));
    const expiry=new Date(Math.min(Date.parse(c.tx.now)+1800000,Date.parse(stamp(v.deadline)))).toISOString();
    await c.tx.query(`INSERT INTO staff_callbacks(id,user_id,visit_id,visit_version,action,expires_at) SELECT x.id,$1,$2,$3,x.action,$4 FROM jsonb_to_recordset($5::jsonb) AS x(id uuid,action text)`,[r.id,visitId,v.version,expiry,JSON.stringify(buttons)]);
    await c.tx.query(`INSERT INTO outbox(logical_key,update_id,kind,chat_id,payload,due_at,entity_id,entity_version,entity_type) VALUES($1,$2,'booking',$3,$4::jsonb,$5,$6,$7,'visit')`,[`decision:${visitId}:${crypto.randomUUID()}`,c.updateId,r.telegram_id,JSON.stringify({event:'visit_pending',visitId,staffUserId:r.id,buttons:buttons.map(b=>b.id)}),c.tx.now,visitId,v.version]);
  }
}
export async function prepareStaffDecision(tx:Tx,visitId:string,userId:string,chatId:string,ids:unknown):Promise<{text:string;keyboard:InlineKeyboardMarkup}|null>{
  const user=(await tx.query<{id:string}>('SELECT id FROM telegram_users WHERE id=$1 AND telegram_id=$2',[userId,chatId]))[0];
  if(!user)return null;
  const v=await staffVisit(tx,visitId,userId);if(!v||!Array.isArray(ids)||ids.length!==2)return null;
  const rows=await tx.query<{id:string;action:string}>(`SELECT id,action FROM staff_callbacks WHERE id=ANY($1::uuid[]) AND user_id=$2 AND visit_id=$3 AND visit_version=$4 AND consumed_at IS NULL`,[ids,userId,visitId,v.version]);
  if(rows.length!==2)return null;
  return {text:`Новая заявка.\nКлиент: ${v.name}\nТелефон: ${v.phone}\nМастер: ${v.barber}\n${new Date(v.start_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} (МСК)\n${v.items.map(i=>i.name).join(', ')}\nСтоимость: ${v.items.reduce((n,i)=>n+i.price,0)/100} ₽\nДлительность: ${v.items.reduce((n,i)=>n+i.duration,0)} мин.`,keyboard:{inline_keyboard:[rows.sort((a)=>a.action==='confirmBooking'?-1:1).map(b=>({text:b.action==='confirmBooking'?'Подтвердить':'Отклонить',callback_data:b.id}))]}};
}
