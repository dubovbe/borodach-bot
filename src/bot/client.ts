import type { Tx } from '../db/client';
import { DomainError, type Actor, type CommandResult, type Draft, type Id } from '../domain/types';
import { executeBooking, type Context } from '../booking/service';
import { reviewedQuote } from '../booking/quote';
import { prepareAvailability, localDate } from '../schedule/service';
import { hashToken, isMeaningfulName as meaningful } from '../identity/service';
import { calendarMonth, createScreenRenderer, type ClientView, type ScreenButton, CONTACT_TEXT, REMOVE_KEYBOARD } from './screens';
import { queueStaffDecision, staffVisit } from './staff';

type State={view:ClientView;lockedBarber:boolean;serviceIds:string[];selectedStart:string|null;month:string;day?:string;phase?:'name'|'contact';quote?:string;submitted?:boolean;blocked?:boolean};
type DraftRow={id:string;user_id:string;barber_id:string|null;version:number;expires_at:Date|string;state:State};
const stamp=(v:Date|string)=>new Date(v).toISOString();
export function createClientController(context:Context,owner:Actor){
  const {tx,userId,updateId}=context;
  if(!userId||!updateId)throw Error('client_context_required');
  let row:DraftRow|undefined;
  let prepared:Awaited<ReturnType<typeof prepareAvailability>>|undefined;
  let summary:Awaited<ReturnType<typeof reviewedQuote>>|undefined;
  const draft=():Draft=>({id:row!.id,telegramId:owner.telegramId,version:row!.version,barberId:row!.barber_id,lockedBarber:row!.state.lockedBarber,serviceIds:row!.state.serviceIds,selectedStart:row!.state.selectedStart,expiresAt:stamp(row!.expires_at)});
  const load=async()=>{row=(await tx.query<DraftRow>('SELECT * FROM drafts WHERE user_id=$1',[userId]))[0];return row;};
  const active=()=>row&&Date.parse(stamp(row.expires_at))>Date.parse(tx.now)&&!row.state.submitted&&!row.state.blocked;
  const data=async()=>{
    if(!row?.barber_id)throw new DomainError('offer_unavailable','Выберите мастера.');
    if(!prepared)prepared=await prepareAvailability({barberId:row.barber_id,serviceIds:row.state.serviceIds,from:tx.now,to:tx.now,actorMode:'client'},tx);
    return prepared;
  };
  const showsSummary=()=>row!.state.view==='summary'&&!row!.state.phase&&!row!.state.submitted&&!row!.state.blocked;
  const cancelScreens=async()=>{await tx.query("UPDATE outbox SET status='cancelled',claim_token=NULL,lease_until=NULL,version=version+1 WHERE draft_id=$1 AND status IN ('pending','leased')",[row!.id]);};
  const persist=async()=>{
    if(showsSummary()){
      const d=await data();summary=await reviewedQuote(row!.barber_id!,row!.state.serviceIds,d.offer,tx);
      row!.state.quote=summary.fingerprint;
    }
    await cancelScreens();
    const saved=(await tx.query<DraftRow>('UPDATE drafts SET barber_id=$2,state=$3::jsonb,version=version+1 WHERE id=$1 RETURNING *',[row!.id,row!.barber_id,JSON.stringify(row!.state)]))[0];row=saved;
  };
  const button=(text:string,action:Record<string,unknown>):ScreenButton=>({text:text.slice(0,100),action});
  const back=()=>button('Назад',{kind:'back'});
  const renderer=createScreenRenderer({
    callbacks:async(d,rows)=>{
      if(!rows.length)rows=[[button('Обновить',{kind:'refresh'})]];
      const all=rows.flat().map(b=>({...b,id:crypto.randomUUID()}));
      await tx.query(`INSERT INTO callbacks(id,user_id,draft_id,draft_version,action,expires_at) SELECT x.id,$1,$2,$3,x.action,LEAST($4::timestamptz,$5::timestamptz+interval '30 minutes') FROM jsonb_to_recordset($6::jsonb) AS x(id uuid,action jsonb)`,[userId,d.id,d.version,d.expiresAt,tx.now,JSON.stringify(all)]);
      let i=0;return {inline_keyboard:rows.map(r=>r.map(b=>({text:b.text,callback_data:all[i++].id})))};
    },
    describe:async(_d,view)=>{
      const s=row!.state;
      if(s.blocked)return {text:'Ссылка мастера недоступна. Откройте новую ссылку или общий вход /start.',rows:[[button('Обновить',{kind:'refresh'})]]};
      if(s.submitted)return {text:'Заявка отправлена и ожидает решения мастера. Для новой записи откройте /start.',rows:[[button('Обновить',{kind:'refresh'})]]};
      if(s.phase==='name')return {text:'Введите ваше имя (от 1 до 80 символов).',rows:[[back()]]};
      if(s.phase==='contact')return {text:CONTACT_TEXT,contact:true,rows:[]};
      if(view==='masters'){
        const masters=await tx.query<{id:string;name:string}>('SELECT id,name FROM barbers WHERE archived_at IS NULL ORDER BY name,id',[]);
        return {text:masters.length?'Выберите мастера.':'Пока нет доступных мастеров. Попробуйте позже или /start.',rows:masters.map(m=>[button(m.name,{kind:'master',id:m.id})])};
      }
      if(view==='services'){
        const services=await tx.query<{id:string;name:string}>(`SELECT s.id,s.name FROM barbers b JOIN assignments a ON a.barber_id=b.id JOIN services s ON s.id=a.service_id LEFT JOIN barber_tariffs bt ON bt.barber_id=b.id AND bt.service_id=s.id LEFT JOIN rank_tariffs rt ON rt.rank_id=b.rank_id AND rt.service_id=s.id WHERE b.id=$1 AND b.archived_at IS NULL AND s.archived_at IS NULL AND COALESCE(bt.price_kopecks,rt.price_kopecks)>=0 AND COALESCE(bt.duration_minutes,rt.duration_minutes)>0 ORDER BY s.name,s.id`,[row!.barber_id]);
        return {text:services.length?'Выберите одну или несколько услуг.':'У мастера пока нет доступных услуг. Попробуйте позже или другой день.',rows:[...services.map(v=>[button(`${s.serviceIds.includes(v.id)?'☑':'☐'} ${v.name}`,{kind:'service',id:v.id})]),...(s.serviceIds.length?[[button('Далее',{kind:'calendar'})]]:[]),...(!s.lockedBarber?[[back()]]:[])]};
      }
      if(view==='calendar'||view==='times'){
        const d=await data();
        if(view==='calendar'){
          const calendar=calendarMonth(s.month,new Set(d.slots({from:`${s.month}-01T00:00:00+03:00`,to:new Date(Date.parse(`${s.month}-01T00:00:00+03:00`)+32*86400000).toISOString(),actorMode:'client'}).map(i=>localDate(i.start))));
          const days=calendar.days.map(day=>button(day.enabled?day.label:`·${day.label}`,day.enabled?{kind:'day',day:day.date}:{kind:'noop'}));
          const rows:ScreenButton[][]=[];for(let i=0;i<days.length;i+=7)rows.push(days.slice(i,i+7));
          const lastMonth=localDate(new Date(Date.parse(tx.now)+d.horizon*86400000).toISOString()).slice(0,7);
          const nav:ScreenButton[]=[];if(calendar.previous>=localDate(tx.now).slice(0,7))nav.push(button('‹',{kind:'month',month:calendar.previous}));if(calendar.next<=lastMonth)nav.push(button('›',{kind:'month',month:calendar.next}));
          return {text:`Выберите день: ${s.month} (МСК).${calendar.days.some(d=>d.enabled)?'':' Нет доступных дней; выберите другой месяц или услуги.'}`,rows:[...rows,...(nav.length?[nav]:[]),[back()]]};
        }
        const slots=d.slots({from:`${s.day}T00:00:00+03:00`,to:`${s.day}T23:59:59+03:00`,actorMode:'client'});
        const times=slots.map(i=>button(new Date(i.start).toLocaleTimeString('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'}),{kind:'time',start:i.start}));const rows:ScreenButton[][]=[];for(let i=0;i<times.length;i+=4)rows.push(times.slice(i,i+4));
        return {text:slots.length?`Выберите время: ${s.day} (МСК).`:'Нет свободного времени. Выберите другой день.',rows:[...rows,[back()]]};
      }
      if(view==='summary'){
        if(!summary)throw Error('summary_not_prepared');
        const {offer}=summary;
        return {text:`Проверьте заявку.\nМастер: ${summary.name}\nАдрес: ${summary.address}\n${new Date(s.selectedStart!).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} (МСК)\n${offer.items.map(i=>i.name).join(', ')}\nСтоимость: ${offer.priceKopecks/100} ₽\nДлительность: ${offer.durationMinutes} мин.\nПосле отправки дождитесь подтверждения мастера.`,rows:[[button('Отправить заявку',{kind:'submit'})],[back()]]};
      }
      return {text:'Для записи откройте /start.',rows:[[back()]]};
    }
  });
  const show=async(status='screen',notice?:string):Promise<CommandResult>=>{
    // A stale-button refresh must review the newly displayed terms and invalidate earlier Submit IDs.
    if(showsSummary()&&!summary)await persist();
    const screen=await renderer(draft(),row!.state.view);
    await cancelScreens();
    await tx.query(`INSERT INTO outbox(logical_key,update_id,kind,chat_id,payload,due_at,draft_id,draft_version) SELECT $1,$2,'client_screen',u.telegram_id,$3::jsonb,$4,$5,$6 FROM telegram_users u WHERE u.id=$7`,[`screen:${updateId}:${crypto.randomUUID()}`,updateId,JSON.stringify({text:(notice?`${notice}\n`:'')+screen.text,reply_markup:screen.keyboard}),tx.now,row!.id,row!.version,userId]);
    return {entityId:row!.id,status,nextWake:tx.now};
  };
  const onboarding=async()=>{
    const p=(await tx.query<{name:string;verified:boolean}>(`SELECT c.name,EXISTS(SELECT 1 FROM phone_claims p WHERE p.client_id=c.id AND p.user_id=c.user_id AND p.phone=c.phone AND p.released_at IS NULL) AS verified FROM clients c WHERE c.user_id=$1`,[userId]))[0];
    row!.state.phase=!p||!meaningful(p.name)?'name':!p.verified?'contact':undefined;
    row!.state.view='summary';
  };
  async function start(payload:string|null):Promise<CommandResult>{
    let barberId:string|null=null,blocked=false;
    if(payload){if(payload.startsWith('b_')&&/^[A-Za-z0-9_-]{20,100}$/.test(payload.slice(2))){barberId=(await tx.query<{id:string}>('SELECT id FROM barbers WHERE public_token_hash=$1 AND archived_at IS NULL',[await hashToken(payload.slice(2))]))[0]?.id??null;blocked=!barberId;}else blocked=true;}
    await load();if(row)await cancelScreens();
    const state:State={view:barberId?'services':'masters',lockedBarber:!!barberId,serviceIds:[],selectedStart:null,month:localDate(tx.now).slice(0,7),blocked};
    row=(await tx.query<DraftRow>(`INSERT INTO drafts(user_id,barber_id,state,expires_at) VALUES($1,$2,$3::jsonb,$4::timestamptz+interval '30 minutes') ON CONFLICT(user_id) DO UPDATE SET barber_id=EXCLUDED.barber_id,state=EXCLUDED.state,expires_at=EXCLUDED.expires_at,version=drafts.version+1 RETURNING *`,[userId,barberId,JSON.stringify(state),tx.now]))[0];
    return show(blocked?'invalid_link':'started');
  }
  async function handleClientAction(actor:Actor,callbackId:Id,actionTx:Tx):Promise<CommandResult>{
    if(actionTx!==tx)throw Error('invalid_context');
    if(actor.telegramId!==owner.telegramId)throw new DomainError('forbidden','Кнопка недоступна.');
    const staff=(await tx.query<{user_id:string;visit_id:string;visit_version:number;action:'confirmBooking'|'declineBooking';expires_at:Date|string;consumed_at:unknown}>('SELECT * FROM staff_callbacks WHERE id::text=$1',[callbackId]))[0];
    if(staff){
      if(staff.user_id!==userId)throw new DomainError('forbidden','Эта кнопка предназначена другому пользователю.');
      const visit=await staffVisit(tx,staff.visit_id,userId);if(!visit)throw new DomainError('forbidden','Заявка недоступна.');
      if(staff.consumed_at||staff.visit_version!==visit.version||Date.parse(stamp(staff.expires_at))<=Date.parse(tx.now)){await queueStaffDecision(context,staff.visit_id,userId);return {status:'stale_callback',nextWake:tx.now};}
      await tx.query('UPDATE staff_callbacks SET consumed_at=$2 WHERE id::text=$1',[callbackId,tx.now]);
      return executeBooking(context,{kind:staff.action,visitId:staff.visit_id,expectedVersion:staff.visit_version});
    }
    const cb=(await tx.query<{user_id:string;draft_id:string;draft_version:number;expires_at:Date|string;consumed_at:unknown;action:Record<string,string>}>('SELECT * FROM callbacks WHERE id::text=$1',[callbackId]))[0];
    if(!cb||cb.user_id!==userId)throw new DomainError('forbidden','Кнопка недоступна. Откройте /start.');
    await load();
    if(!row)return start(null);
    if(Date.parse(stamp(row.expires_at))<=Date.parse(tx.now)){
      await cancelScreens();
      await tx.query(`INSERT INTO outbox(logical_key,update_id,kind,chat_id,payload,due_at) SELECT $1,$2,'start',telegram_id,$3::jsonb,$4 FROM telegram_users WHERE id=$5`,[`expired-form:${updateId}`,updateId,JSON.stringify({text:'Срок формы истёк. Откройте /start или новую ссылку мастера.'}),tx.now,userId]);
      return {status:'stale_callback',nextWake:tx.now};
    }
    if(!active())return show('stale_callback','Заявка уже отправлена или ссылка недоступна. Для новой записи откройте /start.');
    if(cb.draft_id!==row.id||cb.draft_version!==row.version||cb.consumed_at||Date.parse(stamp(cb.expires_at))<=Date.parse(tx.now))return show('stale_callback','Кнопка устарела. Продолжите текущую форму.');
    await tx.query('UPDATE callbacks SET consumed_at=$2 WHERE id::text=$1',[callbackId,tx.now]);
    const s=row.state,a=cb.action;
    if(a.kind==='submit'){
      if(s.view!=='summary'||s.phase||!s.selectedStart||!s.quote) return show('invalid_state');
      try{
        const result=await executeBooking(context,{kind:'requestBooking',barberId:row.barber_id!,serviceIds:s.serviceIds,start:s.selectedStart},s.quote);
        s.submitted=true;await persist();return result;
      }catch(error){
        if(!(error instanceof DomainError)||!['quote_conflict','offer_unavailable','slot_unavailable'].includes(error.code))throw error;
        s.selectedStart=null;s.quote=undefined;prepared=undefined;summary=undefined;
        if(error.code==='quote_conflict'){s.view='calendar';await persist();return show('quote_conflict','Условия изменились. Выберите время и проверьте новый итог.');}
        if(error.code==='slot_unavailable'){s.view='times';await persist();return show('slot_unavailable','Время уже недоступно. Выберите другое.');}
        s.view='services';s.serviceIds=[];await persist();return show('quote_conflict','Выбранные услуги изменились. Проверьте состав заявки.');
      }
    }
    if(a.kind==='master'&&s.view==='masters'&&!s.lockedBarber){const m=await tx.query('SELECT id FROM barbers WHERE id::text=$1 AND archived_at IS NULL',[a.id]);if(!m.length)return show('offer_unavailable');row.barber_id=a.id;s.serviceIds=[];s.view='services';}
    else if(a.kind==='service'&&s.view==='services'){
      const ids=s.serviceIds.includes(a.id)?s.serviceIds.filter(id=>id!==a.id):[...s.serviceIds,a.id];
      if(ids.length)await import('../catalog/service').then(m=>m.effectiveOffer(row!.barber_id!,ids,tx));s.serviceIds=ids;
    }
    else if(a.kind==='calendar'&&s.view==='services'&&s.serviceIds.length){await data();s.view='calendar';}
    else if(a.kind==='month'&&s.view==='calendar'){calendarMonth(a.month,new Set());s.month=a.month;}
    else if(a.kind==='day'&&s.view==='calendar'){
      const d=await data();if(!d.slots({from:`${a.day}T00:00:00+03:00`,to:`${a.day}T23:59:59+03:00`,actorMode:'client'}).length)return show('slot_unavailable','Выберите другой день.');s.day=a.day;s.view='times';
    }
    else if(a.kind==='time'&&s.view==='times'){
      const d=await data();if(!d.slots({from:a.start,to:a.start,actorMode:'client'}).length)return show('slot_unavailable','Время недоступно. Выберите другое.');s.selectedStart=a.start;s.quote=undefined;await onboarding();
    }
    else if(a.kind==='back'){
      if(s.phase){s.phase=undefined;s.view='times';}
      else if(s.view==='summary')s.view='times';else if(s.view==='times')s.view='calendar';else if(s.view==='calendar')s.view='services';else if(s.view==='services'&&!s.lockedBarber){s.view='masters';row.barber_id=null;s.serviceIds=[];}
      s.selectedStart=null;s.quote=undefined;
    }
    else if(!['refresh','noop'].includes(a.kind))return show('invalid_state');
    await persist();return show();
  }
  async function saveDraftInput(text:string):Promise<CommandResult>{
    await load();if(!active())return {status:'ignored_input',nextWake:null};
    if(row!.state.phase==='contact'&&text==='Назад'){
      row!.state.phase=undefined;row!.state.selectedStart=null;row!.state.quote=undefined;row!.state.view='times';await persist();
      const result=await show();
      await tx.query(`INSERT INTO outbox(logical_key,update_id,kind,chat_id,payload,due_at,draft_id,draft_version) SELECT $1,$2,'client_screen',u.telegram_id,$3::jsonb,$4,$5,$6 FROM telegram_users u WHERE u.id=$7`,[`remove:${updateId}`,updateId,JSON.stringify({text:'Выберите другое время кнопкой выше.',reply_markup:REMOVE_KEYBOARD}),tx.now,row!.id,row!.version,userId]);
      return result;
    }
    if(row!.state.phase!=='name')return {status:'ignored_input',nextWake:null};
    if(!meaningful(text))return show('invalid_name','Введите имя одной строкой, от 1 до 80 символов.');
    await tx.query('UPDATE clients SET name=$2,version=version+1 WHERE user_id=$1',[userId,text.trim()]);await onboarding();await persist();return show();
  }
  async function resumeContact():Promise<CommandResult|null>{await load();if(!active()||row!.state.phase!=='contact')return null;await onboarding();await persist();return show();}
  return {start,handleClientAction,saveDraftInput,resumeContact,renderClientScreen:renderer};
}
