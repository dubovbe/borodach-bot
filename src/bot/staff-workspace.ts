import {DomainError,type Actor,type CommandResult,type StaffCommand} from '../domain/types';
import type {Tx} from '../db/client';
import {executeBooking,type Context} from '../booking/service';
import {staffAuthority,prepareManual,executeStaff} from '../booking/staff-service';
import {readReport} from '../reports/service';
import {reportDates,weekDates,staffReason,formatKopecks,staffMonthWindow} from '../reports/input';
import {localDate,prepareAvailability} from '../schedule/service';
import {calendarMonth,type ScreenButton} from './screens';
import {isMeaningfulName,normalizePhone,hashToken} from '../identity/service';

type State={scope:'staff';view:string;barberId?:string;page:number;date:string;month:string;services:string[];name?:string;phone?:string;start?:string;day?:string;input?:string;operation?:StaffCommand;quote?:string;review?:string;reviewReady?:boolean;textKey?:string;textPage?:number;textSeen?:number;textNotice?:string;from?:string;to?:string;reportText?:string;reportFilter?:boolean};
type Row={id:string;version:number;expires_at:Date|string;state:State};
type Callback={user_id:string;draft_id:string;draft_version:number;action:Record<string,any>;expires_at:Date|string;consumed_at:unknown};
type Visit={id:string;version:number;status:string;barber_id:string;start_at:string|Date;name:string;phone:string|null;barber:string;address:string;items:{name:string;price:number;duration:number}[]};
export type StaffScreenScope={userId:string;mode:'admin'|'barber';barberId?:string;historical?:boolean;visits:{id:string;version:number}[]};
const refuse=(code='invalid_state'):never=>{throw new DomainError(code,'Действие недоступно. Откройте /start.');};
const stamp=(value:Date|string)=>new Date(value).toISOString();
const b=(text:string,action:Record<string,unknown>):ScreenButton=>({text:text.slice(0,100),action:{...action,scope:'staff'}});
const index=(value:unknown)=>typeof value==='number'&&Number.isInteger(value)&&value>=0?Math.min(value,10000):0;
const format=(v:string|Date)=>new Date(v).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'});
const visitText=(v:Visit)=>`${v.barber}\n${v.address}\n${format(v.start_at)} (МСК)\n${v.status}\nКлиент: ${v.name}\nТелефон: ${v.phone??'не указан'}\n${v.items.map(i=>`${i.name}: ${formatKopecks(i.price)} ₽, ${i.duration} мин.`).join('\n')}`;
export async function staffScreenAllowed(tx:Tx,chatId:string,scope:StaffScreenScope){
 if(!scope||!['admin','barber'].includes(scope.mode)||typeof scope.userId!=='string'||!Array.isArray(scope.visits))return false;
 const owner=await tx.query('SELECT id FROM telegram_users WHERE id=$1 AND telegram_id=$2',[scope.userId,chatId]);if(!owner.length)return false;
 try{
  const a=await staffAuthority({tx,userId:scope.userId,updateId:null},scope.barberId,scope.historical);
  if(scope.mode==='admin'&&!a.admin||scope.mode==='barber'&&(!a.barber||a.own!==scope.barberId))return false;
  if(scope.visits.length){
   const rows=await tx.query<{id:string;version:number;barber_id:string}>('SELECT id,version,barber_id FROM visits WHERE id=ANY($1::uuid[])',[scope.visits.map(v=>v.id)]);
   if(rows.length!==scope.visits.length||scope.visits.some(v=>!rows.some(r=>r.id===v.id&&r.version===v.version&&(scope.mode==='admin'||r.barber_id===scope.barberId))))return false;
  }
  return true;
 }catch(error){if(error instanceof DomainError)return false;throw error;}
}
export async function handleStaff(c:Context,actor:Actor,input:{callbackId?:string;text?:string;contact?:boolean}):Promise<CommandResult|null>{
 const {tx,userId,updateId}=c;let cb:Callback|undefined;
 if(input.callbackId){cb=(await tx.query<Callback>('SELECT * FROM callbacks WHERE id::text=$1',[input.callbackId]))[0];if(cb?.action.scope==='admin'||cb?.action.kind==='admin')return null;}
 let row=(await tx.query<Row>('SELECT * FROM drafts WHERE user_id=$1',[userId]))[0];
 if(cb?.action.scope!=='staff'&&row?.state.scope!=='staff')return null;
 if(cb&&cb.user_id!==userId)refuse('forbidden');
 const historical=cb?.action.kind==='staffReport'||row?.state.scope==='staff'&&(row.state.view==='report'||row.state.reportFilter===true||row.state.view==='input'&&row.state.input==='period');
 const access=await staffAuthority(c,undefined,historical);
 if(!row||Date.parse(stamp(row.expires_at))<=Date.parse(tx.now))refuse('stale_callback');
 const stale=!!cb&&(cb.action.scope!=='staff'||cb.draft_id!==row.id||cb.draft_version!==row.version||!!cb.consumed_at||Date.parse(stamp(cb.expires_at))<=Date.parse(tx.now));
 if(stale&&row.state.scope!=='staff')refuse('stale_callback');
 const fresh=():State=>({scope:'staff',view:'home',barberId:access.admin?undefined:access.own!,page:0,date:localDate(tx.now),month:localDate(tx.now).slice(0,7),services:[]});
 let s:State=row.state.scope==='staff'?row.state:fresh();
 if(!access.admin&&s.barberId!==access.own)refuse('forbidden');
 let notice=stale?'Кнопка устарела. Продолжите текущую форму.':undefined,result:CommandResult|undefined,textPage:number|undefined;
 const home=()=>{s=fresh();};
 const recoverManual=(error:unknown)=>{
  if(!(error instanceof DomainError)||!['offer_unavailable','slot_unavailable'].includes(error.code)||!['services','calendar','times','manualReview'].includes(s.view))throw error;
  s.start=undefined;s.quote=undefined;s.review=undefined;s.reviewReady=false;s.textKey=undefined;s.textPage=0;s.textSeen=0;s.textNotice=undefined;s.page=0;s.input=undefined;
  if(error.code==='offer_unavailable'){s.services=[];s.view='services';s.day=undefined;notice='Выбранные услуги изменились. Выберите доступный состав заново.';}
  else{s.view=s.day?'times':'calendar';notice='Время уже недоступно. Выберите другое время или день.';}
 };
 const selected=async()=>{if(!s.barberId)refuse();await staffAuthority(c,s.barberId);return s.barberId!;};
 const visit=async(id:string,version?:number)=>{
  const meta=(await tx.query<{barber_id:string}>('SELECT barber_id FROM visits WHERE id::text=$1',[id]))[0];if(!meta)refuse('not_found');
  await staffAuthority(c,meta!.barber_id);
  const v=(await tx.query<Visit>(`SELECT v.id,v.version,v.status,v.barber_id,v.start_at,b.name AS barber,s.address,
   COALESCE(NULLIF(trim(c.name),''),(SELECT a.data->>'manualClientName' FROM audit_events a WHERE a.entity_id=v.id AND a.kind='visit_confirmed' AND a.data ? 'manualClientName' ORDER BY a.created_at LIMIT 1),'') AS name,c.phone,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('name',i.name,'price',i.price_kopecks,'duration',i.duration_minutes) ORDER BY i.id) FROM visit_items i WHERE i.visit_id=v.id),'[]'::jsonb) AS items
   FROM visits v JOIN clients c ON c.id=v.client_id JOIN barbers b ON b.id=v.barber_id CROSS JOIN shop s WHERE v.id::text=$1`,[id]))[0];
  if(!v||version!==undefined&&v.version!==version)refuse('stale_version');return v!;
 };
 const manual=():Extract<StaffCommand,{kind:'createManualBooking'}>=>({kind:'createManualBooking',barberId:s.barberId!,clientName:s.name!,phone:s.phone!,serviceIds:s.services,start:s.start!});
 const reviewManual=async()=>{
  const q=await prepareManual(c,manual());s.name=q.name;s.quote=q.fingerprint;s.reviewReady=false;s.view='manualReview';
  s.review=`Проверьте ручную запись.${q.canonical?'\nНайден подтверждённый профиль клиента.':''}\nКлиент: ${q.name}\nТелефон: ${q.phone}\nМастер: ${q.masterName}\n${q.address}\n${format(q.start)} (МСК)\n${q.offer.items.map(i=>`${i.name}: ${formatKopecks(i.priceKopecks)} ₽, ${i.durationMinutes} мин.`).join('\n')}\nСтоимость: ${formatKopecks(q.offer.priceKopecks)} ₽\nДлительность: ${q.offer.durationMinutes} мин.`;
 };
 const beginReport=async()=>{
  const from=s.from??s.date,to=s.to??s.date,report=await readReport(actor,{fromLocalDate:from,toLocalDate:to,barberId:s.barberId},tx);
  const label=access.admin?(s.barberId?`Мастер: ${(await tx.query<{name:string}>('SELECT name FROM barbers WHERE id::text=$1',[s.barberId]))[0]?.name??'недоступен'}`:'Все мастера'):'Мой отчёт';
  s.reportText=`Статистика ${from} — ${to}\n${label}\nСнимок на ${format(tx.now)} (МСК)\nЗавершено: ${report.completed}\nНеявки: ${report.noShows}\nСтоимость оказанных услуг: ${formatKopecks(report.serviceValueKopecks)} ₽`;s.view='report';
 };
 try{if(!stale&&cb){
  await tx.query('UPDATE callbacks SET consumed_at=$2 WHERE id::text=$1',[input.callbackId,tx.now]);const a=cb.action;
  if(a.kind==='staff'||a.kind==='home')home();
  else if(a.kind==='staffReport'){s=fresh();await beginReport();}
  else if(a.kind==='textPage'&&a.key===s.textKey)textPage=index(a.page);
  else if(a.kind==='page')s.page=index(a.page);
  else if(a.kind==='masters'||a.kind==='reportMasters'){if(!access.admin)refuse('forbidden');s.reportFilter=a.kind==='reportMasters';s.view='masters';s.page=0;}
  else if(a.kind==='master'){
   if(a.id!==null)await staffAuthority(c,String(a.id));else if(!access.admin)refuse('forbidden');
   s.barberId=a.id??undefined;s.page=0;if(s.reportFilter){s.reportFilter=false;await beginReport();}else s.view='home';
  }
  else if(a.kind==='today'||a.kind==='week'||a.kind==='pending'){
   if(a.kind==='today')s.date=localDate(tx.now);s.view=a.kind==='pending'?'pending':a.kind==='week'?'week':'day';s.page=0;
  }
  else if(a.kind==='date'){s.view='input';s.input='date';}
  else if(a.kind==='manual'){await selected();s.view='services';s.services=[];s.page=0;s.quote=undefined;}
  else if(a.kind==='service'&&s.view==='services'){
   const id=String(a.id);s.services=s.services.includes(id)?s.services.filter(x=>x!==id):[...s.services,id];
   if(s.services.length)await import('../catalog/service').then(m=>m.effectiveOffer(s.barberId!,s.services,tx));
  }
  else if(a.kind==='manualName'&&s.services.length){if(s.name&&s.phone)s.view='calendar';else{s.view='input';s.input='name';}}
  else if(a.kind==='manualCalendar'&&s.view==='times'){s.view='calendar';s.start=undefined;}
  else if(a.kind==='month'&&s.view==='calendar'){calendarMonth(String(a.month),new Set());s.month=String(a.month);}
  else if(a.kind==='day'&&s.view==='calendar'){reportDates(a.day,a.day);s.day=a.day;s.view='times';s.page=0;}
  else if(a.kind==='time'&&s.view==='times'){s.start=String(a.start);await reviewManual();}
  else if(a.kind==='visit'){const v=await visit(String(a.id),Number(a.version));s.operation={kind:'markOutcome',visitId:v.id,expectedVersion:v.version,outcome:'completed'};s.view='visit';}
  else if((a.kind==='confirmPending'||a.kind==='declinePending')&&s.operation&&'visitId' in s.operation){
   const v=await visit(s.operation.visitId,s.operation.expectedVersion);result=await executeBooking(c,{kind:a.kind==='confirmPending'?'confirmBooking':'declineBooking',visitId:v.id,expectedVersion:v.version});home();notice='Готово.';
  }
  else if(a.kind==='cancel'&&s.operation){s.operation={kind:'staffCancelBooking',visitId:s.operation.kind==='createManualBooking'?'':s.operation.visitId,expectedVersion:'expectedVersion' in s.operation?s.operation.expectedVersion:0,reason:''};s.view='input';s.input='reason';}
  else if((a.kind==='outcome'||a.kind==='correct')&&s.operation&&'visitId' in s.operation){
   if(a.outcome!=='completed'&&a.outcome!=='no_show')refuse();
   if(a.kind==='correct'){if(!access.admin)refuse('forbidden');s.operation={kind:'correctOutcome',visitId:s.operation.visitId,expectedVersion:s.operation.expectedVersion,outcome:a.outcome,reason:''};s.view='input';s.input='reason';}
   else{s.operation={kind:'markOutcome',visitId:s.operation.visitId,expectedVersion:s.operation.expectedVersion,outcome:a.outcome};const v=await visit(s.operation.visitId,s.operation.expectedVersion);s.review=visitText(v)+`\nНовый результат: ${a.outcome==='completed'?'Визит завершён':'Не явился'}`;s.reviewReady=false;s.view='review';}
  }
  else if(a.kind==='report'){s.from=s.date;s.to=s.date;await beginReport();}
  else if(a.kind==='reportWeek'){const week=weekDates(s.date);s.from=week.from;s.to=week.to;await beginReport();}
  else if(a.kind==='reportPeriod'){s.view='input';s.input='period';}
  else if(a.kind==='confirm'&&s.reviewReady){
   if(s.view==='manualReview'){
    const q=await prepareManual(c,manual());
    if(q.fingerprint!==s.quote){await reviewManual();notice='Данные изменились. Проверьте новый итог и подтвердите ещё раз.';}
    else{result=await executeStaff(c,manual(),s.quote);home();notice='Запись подтверждена.';}
   }else if(s.view==='review'&&s.operation){result=await executeStaff(c,s.operation);home();notice='Готово.';}
  }
 }}catch(error){recoverManual(error);}
 if(!stale&&input.text!==undefined&&s.view==='input'){
  try{
   if(s.input==='name'){if(!isMeaningfulName(input.text))refuse('invalid_name');s.name=input.text.trim();s.input='phone';}
   else if(s.input==='phone'){s.phone=normalizePhone(input.text);s.view='calendar';s.month=localDate(tx.now).slice(0,7);}
   else if(s.input==='date'){reportDates(input.text,input.text);s.date=input.text;s.view='day';s.page=0;}
   else if(s.input==='period'){const parts=input.text.trim().split(/\s+/);if(parts.length!==2)refuse('invalid_input');reportDates(parts[0],parts[1]);s.from=parts[0];s.to=parts[1];await beginReport();}
   else if(s.input==='reason'&&s.operation&&'reason' in s.operation&&'visitId' in s.operation){s.operation.reason=staffReason(input.text);const v=await visit(s.operation.visitId,s.operation.expectedVersion);s.review=visitText(v)+`\n${s.operation.kind==='staffCancelBooking'?'Отменить запись':`Исправить результат: ${s.operation.outcome==='completed'?'Визит завершён':'Не явился'}`}\nПричина: ${s.operation.reason}`;s.view='review';s.reviewReady=false;}
  }catch(error){if(!(error instanceof DomainError)||error.code==='forbidden')throw error;notice='Некорректное значение. Попробуйте ещё раз.';}
 }
 const historicalScreen=s.view==='report'||s.reportFilter===true||s.view==='input'&&s.input==='period';
 if(!historicalScreen)await staffAuthority(c,s.barberId);
 let manualSlots:{start:string;end:string}[]=[],manualDays:string[]=[];
 if(s.view==='calendar'||s.view==='times'){
  try{
   await selected();const range=s.view==='calendar'?staffMonthWindow(s.month):{from:`${s.day}T00:00:00+03:00`,to:`${s.day}T23:59:59.999+03:00`};
   const input={barberId:s.barberId!,serviceIds:s.services,...range,actorMode:'staff' as const},data=await prepareAvailability(input,tx);if(s.view==='calendar')manualDays=data.availableDays(input);else manualSlots=data.slots(input);
  }catch(error){recoverManual(error);}
 }
 let text='',rows:ScreenButton[][]=[],displayed:Visit[]=[];
 const back=[b('К рабочему месту',{kind:'home'})];
 if(s.view==='home'){
  text='Рабочее место';rows=[[b('Сегодня',{kind:'today'}),b('День',{kind:'date'}),b('Неделя',{kind:'week'})],[b('Ожидающие заявки',{kind:'pending'})],[b('Ручная запись',{kind:'manual'})],[b('Статистика',{kind:'report'})]];
  if(access.admin)rows.push([b('Фильтр мастера',{kind:'masters'})]);
  if(!s.barberId)text+='\nВсе мастера. Для ручной записи выберите мастера.';
 }else if(s.view==='masters'){
  const masters=await tx.query<{id:string;name:string}>(s.reportFilter?'SELECT id,name FROM barbers ORDER BY name,id LIMIT 6 OFFSET $1':'SELECT id,name FROM barbers WHERE archived_at IS NULL ORDER BY name,id LIMIT 6 OFFSET $1',[s.page*5]);
  text='Выберите мастера';rows=masters.slice(0,5).map(m=>[b(m.name,{kind:'master',id:m.id})]);if(s.page)rows.push([b('‹',{kind:'page',page:s.page-1})]);if(masters.length>5)rows.push([b('›',{kind:'page',page:s.page+1})]);rows.push([b('Все мастера',{kind:'master',id:null})],back);
 }else if(['day','week','pending'].includes(s.view)){
  const range=s.view==='week'?weekDates(s.date):{from:s.date,to:s.date};
  const visits=await tx.query<Visit>(`SELECT v.id,v.version,v.status,v.barber_id,v.start_at,b.name AS barber FROM visits v JOIN barbers b ON b.id=v.barber_id WHERE ($1::text IS NULL OR v.barber_id::text=$1)
   AND (CASE WHEN $2='pending' THEN v.status='pending' ELSE v.start_at>=($3::date::timestamp AT TIME ZONE 'Europe/Moscow') AND v.start_at<(($4::date+1)::timestamp AT TIME ZONE 'Europe/Moscow') END)
   ORDER BY v.start_at,v.id LIMIT 6 OFFSET $5`,[s.barberId??null,s.view,range.from,range.to,s.page*5]);
  displayed=visits.slice(0,5);text=`${s.view==='pending'?'Ожидающие заявки':`${range.from} — ${range.to}`}\n`+(displayed.length?displayed.map(v=>`${format(v.start_at)} (МСК) · ${v.barber} · ${v.status}`).join('\n'):'Записей нет.');rows=displayed.map(v=>[b(format(v.start_at),{kind:'visit',id:v.id,version:v.version})]);if(s.page)rows.push([b('‹',{kind:'page',page:s.page-1})]);if(visits.length>5)rows.push([b('›',{kind:'page',page:s.page+1})]);rows.push(back);
 }else if(s.view==='visit'&&s.operation&&'visitId' in s.operation){
  const v=await visit(s.operation.visitId,s.operation.expectedVersion);displayed=[v];text=visitText(v);
  if(['pending','confirmed'].includes(v.status))rows.push([b('Отменить с причиной',{kind:'cancel'})]);
  if(v.status==='pending')rows.push([b('Подтвердить заявку',{kind:'confirmPending'}),b('Отклонить заявку',{kind:'declinePending'})]);
  if(v.status==='confirmed'&&Date.parse(stamp(v.start_at))<=Date.parse(tx.now))rows.push([b('Визит завершён',{kind:'outcome',outcome:'completed'}),b('Не явился',{kind:'outcome',outcome:'no_show'})]);
  if(access.admin&&['completed','no_show'].includes(v.status))rows.push([b('Исправить результат',{kind:'correct',outcome:v.status==='completed'?'no_show':'completed'})]);
  rows.push(back);
 }else if(s.view==='services'){
  await selected();const services=await tx.query<{id:string;name:string}>(`SELECT s.id,s.name FROM services s JOIN assignments a ON a.service_id=s.id JOIN barbers b ON b.id=a.barber_id LEFT JOIN barber_tariffs bt ON bt.barber_id=b.id AND bt.service_id=s.id LEFT JOIN rank_tariffs rt ON rt.rank_id=b.rank_id AND rt.service_id=s.id WHERE b.id=$1 AND b.archived_at IS NULL AND s.archived_at IS NULL AND COALESCE(bt.duration_minutes,rt.duration_minutes)>0 ORDER BY s.name,s.id LIMIT 6 OFFSET $2`,[s.barberId,s.page*5]);
  text='Выберите услуги';rows=services.slice(0,5).map(v=>[b(`${s.services.includes(v.id)?'☑':'☐'} ${v.name}`,{kind:'service',id:v.id})]);if(s.page)rows.push([b('‹',{kind:'page',page:s.page-1})]);if(services.length>5)rows.push([b('›',{kind:'page',page:s.page+1})]);if(s.services.length)rows.push([b('Далее',{kind:'manualName'})]);rows.push(back);
 }else if(s.view==='calendar'||s.view==='times'){
  const slots=manualSlots;
  if(s.view==='calendar'){
   text=`Выберите дату: ${s.month}`;const cal=calendarMonth(s.month,new Set(manualDays));
   for(let n=0;n<cal.days.length;n+=7)rows.push(cal.days.slice(n,n+7).map(d=>b(d.enabled?d.label:'·',d.enabled?{kind:'day',day:d.date}:{kind:'noop'})));
   rows.push([b('‹',{kind:'month',month:cal.previous}),b('›',{kind:'month',month:cal.next})],back);
  }else{text=`Выберите время: ${s.day} (МСК)`;rows=slots.slice(s.page*5,s.page*5+5).map(slot=>[b(new Date(slot.start).toLocaleTimeString('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'}),{kind:'time',start:slot.start})]);if(s.page)rows.push([b('‹',{kind:'page',page:s.page-1})]);if(slots.length>s.page*5+5)rows.push([b('›',{kind:'page',page:s.page+1})]);rows.push([b('Другой день',{kind:'manualCalendar'})],back);}
 }else if(s.view==='input'){
  text=s.input==='name'?'Введите имя клиента одной строкой.':s.input==='phone'?'Введите телефон клиента.':s.input==='date'?'Введите дату YYYY-MM-DD.':s.input==='period'?'Введите период: YYYY-MM-DD YYYY-MM-DD.':'Введите причину одной строкой (1–500 символов).';rows=[back];
 }else if(s.view==='manualReview'||s.view==='review'){text=s.review??'';rows=[[b('Подтвердить',{kind:'confirm'})],back];if(s.operation&&'visitId' in s.operation)displayed=[await visit(s.operation.visitId,s.operation.expectedVersion)];}
 else if(s.view==='report'){text=s.reportText??'';rows=[[b('За неделю',{kind:'reportWeek'}),b('За период',{kind:'reportPeriod'})],...(access.admin?[[b('Фильтр мастера',{kind:'reportMasters'})]]:[]),back];}
 const prefix=textPage!==undefined?s.textNotice:notice,display=(prefix?prefix+'\n\n':'')+text,key=await hashToken(display),pages:string[]=[];
 for(let n=0;n<display.length;){let end=Math.min(n+3800,display.length);if(/[\uD800-\uDBFF]/.test(display[end-1]))end--;pages.push(display.slice(n,end));n=end;}if(!pages.length)pages.push('Рабочее место');
 if(textPage!==undefined&&s.textKey===key){s.textPage=Math.min(textPage,pages.length-1,(s.textSeen??0)+1);s.textSeen=Math.max(s.textSeen??0,s.textPage);}else{s.textPage=0;s.textSeen=0;}
 s.textKey=key;s.textNotice=prefix;s.reviewReady=['review','manualReview'].includes(s.view)&&s.textPage===pages.length-1&&s.textSeen>=pages.length-1;
 if(!s.reviewReady)rows=rows.map(r=>r.filter(v=>v.action.kind!=='confirm')).filter(r=>r.length);
 if(pages.length>1){const nav:ScreenButton[]=[];if(s.textPage)nav.push(b('Назад по тексту',{kind:'textPage',page:s.textPage-1,key}));if(s.textPage<pages.length-1)nav.push(b('Далее по тексту',{kind:'textPage',page:s.textPage+1,key}));rows.push(nav);}
 text=(pages.length>1?`Страница ${s.textPage+1}/${pages.length}\n\n`:'')+pages[s.textPage];
 await tx.query("UPDATE outbox SET status='cancelled',claim_token=NULL,lease_until=NULL,version=version+1 WHERE draft_id=$1 AND status IN ('pending','leased')",[row.id]);
 row=(await tx.query<Row>('UPDATE drafts SET barber_id=$2,state=$3::jsonb,version=version+1 WHERE id=$1 RETURNING *',[row.id,s.barberId??null,JSON.stringify(s)]))[0];
 const buttons=rows.flat().map(v=>({...v,id:crypto.randomUUID()}));await tx.query(`INSERT INTO callbacks(id,user_id,draft_id,draft_version,action,expires_at) SELECT x.id,$1,$2,$3,x.action,LEAST($4::timestamptz,$5::timestamptz+interval '30 minutes') FROM jsonb_to_recordset($6::jsonb) AS x(id uuid,action jsonb)`,[userId,row.id,row.version,row.expires_at,tx.now,JSON.stringify(buttons)]);
 let n=0;const scope:StaffScreenScope={userId:userId!,mode:access.admin?'admin':'barber',barberId:s.barberId,historical:historicalScreen,visits:displayed.map(v=>({id:v.id,version:v.version}))};
 await tx.query(`INSERT INTO outbox(logical_key,update_id,kind,chat_id,payload,due_at,draft_id,draft_version) SELECT $1,$2,'client_screen',u.telegram_id,$3::jsonb,$4,$5,$6 FROM telegram_users u WHERE u.id=$7`,[`staff:${updateId}`,updateId,JSON.stringify({staffScreen:scope,text,reply_markup:{inline_keyboard:rows.map(r=>r.map(v=>({text:v.text,callback_data:buttons[n++].id})))}}),tx.now,row.id,row.version,userId]);
 return result??{status:stale?'stale_callback':'staff_screen',nextWake:tx.now};
}
