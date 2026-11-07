import type {Context} from '../booking/service';
import type {Actor,AdminCommand,CommandResult,Conflict} from '../domain/types';
import {DomainError} from '../domain/types';
import {executeAdmin,requireAdmin,activeEntity} from '../catalog/management';
import {issueBarberInvite,revokeInvite,publicBookingToken,hashToken,type IdentityOptions} from '../identity/service';
import {calendarMonth,type ScreenButton} from './screens';
import {localDate,loadSchedule} from '../schedule/service';
import {parseName,parseRoubles,parseMinutes,parseIntervals,parseHorizon,parseDate} from './admin-input';

type Table='services'|'ranks'|'barbers';
type Mutation=AdminCommand|{kind:'issueBarberInvite';barberId:string}|{kind:'revokeInvite';invitationId:string;barberId:string};
type State={scope:'admin';view:'home'|'list'|'card'|'input'|'ranks'|'services'|'service'|'weekday'|'calendar'|'review'|'conflicts';table?:Table;id?:string;serviceId?:string;page:number;month:string;command?:Mutation;barberIntent?:'rank'|'profile';fields?:('name'|'priceKopecks'|'durationMinutes'|'intervals'|'days')[];fingerprint?:string;review?:string;conflicts?:Conflict[];textKey?:string;textPage?:number;textSeen?:number;textNotice?:string;reviewReady?:boolean};
type Row={id:string;version:number;expires_at:Date|string;state:State};
type Callback={user_id:string;draft_id:string;draft_version:number;action:Record<string,unknown>;consumed_at:unknown;expires_at:string|Date};
const refuse=(code='invalid_state',message='Обновите форму через /start.'):never=>{throw new DomainError(code,message);};
const stamp=(value:Date|string)=>new Date(value).toISOString();
const dayNames=['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'];
const labels={services:'Услуги',ranks:'Ранги',barbers:'Мастера'};
const clock=(n:number)=>`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
const intervals=(items:{startMinute:number;endMinute:number}[])=>items.length?items.map(i=>`${clock(i.startMinute)}–${clock(i.endMinute)}`).join(', '):'Выходной';
const button=(text:string,action:Record<string,unknown>):ScreenButton=>({text:text.slice(0,100),action:{...action,scope:'admin'}});
const back=()=>[button('К управлению',{kind:'home'})];
const integer=(value:unknown)=>typeof value==='number'&&Number.isInteger(value)&&value>=0?Math.min(value,10000):0;
// Leave space for the page header. Split presentation only, preserving every
// character and the complete canonical command independently of navigation.
function textPages(text:string):string[]{
 const pages:string[]=[];
 for(let start=0;start<text.length;){let end=Math.min(start+3800,text.length);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;pages.push(text.slice(start,end));start=end;}
 return pages.length?pages:[''];
}
export async function handleAdmin(c:Context,actor:Actor,input:{callbackId?:string;text?:string;contact?:boolean},options:IdentityOptions={}):Promise<CommandResult|null>{
 const {tx,userId,updateId}=c;let cb:Callback|undefined,authorized=false;
 if(input.callbackId){cb=(await tx.query<Callback>('SELECT * FROM callbacks WHERE id::text=$1',[input.callbackId]))[0];if(!cb||cb.action.scope==='staff')return null;if(cb.action.kind==='admin'||cb.action.scope==='admin'){if(cb.user_id!==userId)refuse('forbidden','Кнопка недоступна.');await requireAdmin(c);authorized=true;}}
 if(!authorized){
  const access=(await tx.query<{scope:string|null;admin:boolean}>(`SELECT d.state->>'scope' AS scope,EXISTS(SELECT 1 FROM roles WHERE user_id=$1 AND role='admin') AS admin FROM drafts d WHERE d.user_id=$1`,[userId]))[0];
  if(access?.scope!=='admin')return null;
  if(!access.admin)refuse('forbidden','Управление доступно администратору.');
 }
 let row=(await tx.query<Row>('SELECT * FROM drafts WHERE user_id=$1',[userId]))[0];if(row?.state.scope!=='admin'&&(!cb||(cb.action.kind!=='admin'&&cb.action.scope!=='admin')))return null;
 if(cb&&cb.user_id!==userId)refuse('forbidden','Кнопка недоступна.');
 if(!row||Date.parse(stamp(row.expires_at))<=Date.parse(tx.now))refuse('stale_callback','Срок формы истёк. Откройте /start.');
 const stale=!!cb&&((cb.action.scope!=='admin'&&cb.action.kind!=='admin')||cb.draft_id!==row.id||cb.draft_version!==row.version||!!cb.consumed_at||Date.parse(stamp(cb.expires_at))<=Date.parse(tx.now));
 if(stale&&row.state.scope!=='admin')refuse('stale_callback','Кнопка устарела. Откройте управление снова.');
 let s:State=row.state.scope==='admin'?row.state:{scope:'admin',view:'home',page:0,month:localDate(tx.now).slice(0,7)};
 const entity=async()=>{if(!s.table||!s.id)return refuse();return activeEntity(c,s.table,s.id);};
 const list=async(table:Table,page=s.page)=>tx.query<{id:string;name:string;version:number}>(`SELECT id,name,version FROM ${table} WHERE archived_at IS NULL ORDER BY name,id LIMIT 6 OFFSET $1`,[page*5]);
 const selectionRows=(items:{id:string;name:string}[],kind:string,table:Table)=>[...items.slice(0,5).map(e=>[button(e.name,{kind,id:e.id,table})]),...(s.page?[[button('‹',{kind:'page',page:s.page-1})]]:[]),...(items.length>5?[[button('›',{kind:'page',page:s.page+1})]]:[])];
 // Capture every identity/version affecting displayed terms, including absence of overrides/invites.
 const dependencies=async(command:Mutation)=>{
  const serviceId='serviceId' in command?command.serviceId:null;
  const rankId='rankId' in command?command.rankId:null;
  const barberId='barberId' in command?command.barberId:null;
  const rows=await tx.query<{snapshot:Record<string,any>}>(`SELECT jsonb_build_object(
   'service',(SELECT to_jsonb(s) FROM services s WHERE s.id::text=$1),
   'rank',(SELECT to_jsonb(r) FROM ranks r WHERE r.id::text=$2),
   'barber',(SELECT to_jsonb(b)-'public_token_hash' FROM barbers b WHERE b.id::text=$3),
   'barberRank',(SELECT to_jsonb(r) FROM ranks r JOIN barbers b ON b.rank_id=r.id WHERE b.id::text=$3),
   'rankTariff',(SELECT to_jsonb(t) FROM rank_tariffs t WHERE t.rank_id::text=COALESCE($2,(SELECT rank_id::text FROM barbers WHERE id::text=$3)) AND t.service_id::text=$1),
   'override',(SELECT to_jsonb(t) FROM barber_tariffs t WHERE t.barber_id::text=$3 AND t.service_id::text=$1),
   'assignment',(SELECT to_jsonb(a) FROM assignments a WHERE a.barber_id::text=$3 AND a.service_id::text=$1),
   'invitations',COALESCE((SELECT jsonb_agg(to_jsonb(i)-'token_hash' ORDER BY i.id) FROM invitations i WHERE i.barber_id::text=$3 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>$4),'[]'::jsonb),
   'settings',(SELECT to_jsonb(x) FROM settings x WHERE x.shop_id=1)) AS snapshot`,[serviceId,rankId,barberId,tx.now]);
  const snapshot=rows[0].snapshot;
  if(command.kind==='issuePublicLink'||command.kind==='showPublicLink'){const barber=await activeEntity(c,'barbers',command.barberId);const hash=await hashToken(await publicBookingToken(command.barberId,options.invitationSecret));snapshot.publicLink=barber.public_token_hash===hash?'managed':barber.public_token_hash?'legacy':'absent';}
  if(command.kind!=='setBookingHorizon')delete snapshot.settings;
  if(command.kind!=='issueBarberInvite'&&command.kind!=='revokeInvite')delete snapshot.invitations;
  return snapshot;
 };
 const review=async(command:Mutation,rebase=false)=>{
  const d=await dependencies(command);
  if(rebase&&'expectedVersion' in command&&command.expectedVersion!==null){
   const owner=d.barber??d.rank??d.service??d.settings;
   if(!owner||owner.archived_at)refuse('not_found','Объект больше недоступен. Откройте управление заново.');
   // Only fields chosen in this wizard are proposed changes. Rank-only editing must
   // retain a concurrent rename while preserving the explicitly selected new rank.
   if(command.kind==='saveBarber'&&s.barberIntent==='rank')command.name=owner.name;
   command.expectedVersion=owner.version;
  }
  const text:string[]=['Проверьте изменения.'];
  if(d.service)text.push(`Услуга: ${d.service.name}`);if(d.rank)text.push(`Ранг: ${d.rank.name}`);if(d.barber)text.push(`Мастер: ${d.barber.name}`,`Текущий ранг: ${d.barberRank?.name??'без ранга'}`);
  if(d.rankTariff)text.push(`Ранговый тариф сейчас: ${d.rankTariff.price_kopecks/100} ₽, ${d.rankTariff.duration_minutes} мин.`);
  if(d.override)text.push(`Индивидуальный тариф сейчас: ${d.override.price_kopecks/100} ₽, ${d.override.duration_minutes} мин.`);
  if('name' in command)text.push(`Имя / название: ${command.name}`);
  if('priceKopecks' in command)text.push(`Новый тариф: ${command.priceKopecks/100} ₽, ${command.durationMinutes} мин.`);
  if(command.kind==='saveBarber')text.push(`Новый ранг: ${command.rankId?d.rank?.name??'недоступен':'без ранга'}`);
  if(command.kind==='assignBarberService')text.push(command.assigned?'Назначить услугу мастеру':'Убрать услугу из назначения');
  if(command.kind==='setBarberTariff'&&command.operation==='reset')text.push('Удалить индивидуальный тариф. Будет действовать ранговый тариф, если он задан.');
  if(command.kind.startsWith('archive'))text.push('Архивировать. История записей сохранится.');
  if(command.kind==='saveWeeklyHours'){const current=await loadSchedule(command.barberId,tx);text.push(`${dayNames[command.weekday-1]} сейчас: ${intervals(current.weekly[command.weekday]??[])}`,`Новый график: ${intervals(command.intervals)}`);}
  if(command.kind==='saveDateException'){const current=await loadSchedule(command.barberId,tx);text.push(`${command.date} сейчас: ${current.exceptions[command.date]?intervals(current.exceptions[command.date]):'недельный график'}`,`Новый график: ${command.intervals===null?'Вернуться к недельному графику':intervals(command.intervals)}`);}
  if(command.kind==='setBookingHorizon')text.push(`Горизонт сейчас: ${d.settings.booking_horizon_days} дней. Новый: ${command.days} дней. Существующие записи сохранятся.`);
  if(command.kind==='issueBarberInvite')text.push('Создать приглашение на 24 часа. Предыдущие открытые приглашения перестанут действовать.');
  if(command.kind==='revokeInvite')text.push('Отозвать открытое приглашение.');
  if(command.kind==='showPublicLink')text.push('Показать персональную ссылку мастера.');
  if(command.kind==='issuePublicLink')text.push(d.publicLink==='managed'?'Показать действующую ссылку мастера.':d.publicLink==='legacy'?'Создать персональную ссылку. Предыдущая ссылка перестанет работать.':'Создать персональную ссылку мастера.');
  return {fingerprint:JSON.stringify(d),text:text.join('\n')};
 };
 const beginReview=async()=>{if(!s.command)refuse();const r=await review(s.command!,true);s.fingerprint=r.fingerprint;s.review=r.text;s.reviewReady=false;s.view='review';};
 const beginInput=(command:Mutation,fields:State['fields'])=>{s.command=command;s.fields=fields;s.view='input';};
 let result:CommandResult|undefined,notice=stale?'Кнопка устарела. Продолжите текущую форму.':undefined,textRequest:number|undefined;
 if(!stale&&cb){await tx.query('UPDATE callbacks SET consumed_at=$2 WHERE id::text=$1',[input.callbackId,tx.now]);const a=cb.action,kind=a.kind;
  if(kind==='home'||kind==='admin'){s={scope:'admin',view:'home',page:0,month:localDate(tx.now).slice(0,7)};}
  else if(kind==='list'&&['services','ranks','barbers'].includes(String(a.table))){s.table=a.table as Table;s.id=undefined;s.page=0;s.view='list';}
  else if(kind==='page'){s.page=integer(a.page);}
  else if(kind==='textPage'&&a.key===s.textKey){textRequest=integer(a.page);}
  else if(kind==='card'){s.table=a.table as Table;s.id=String(a.id);s.page=0;await entity();s.view='card';}
  else if(kind==='create'||kind==='rename'){
   const current=kind==='rename'?await entity():null;s.id=current?.id;s.command=undefined;
   if(s.table==='services')beginInput({kind:'saveService',serviceId:current?.id??null,expectedVersion:current?.version??null,name:''},['name']);
   else if(s.table==='ranks')beginInput({kind:'saveRank',rankId:current?.id??null,expectedVersion:current?.version??null,name:''},['name']);
   else if(s.table==='barbers'){s.barberIntent='profile';beginInput({kind:'saveBarber',barberId:current?.id??null,expectedVersion:current?.version??null,name:'',rankId:current?.rank_id??null},['name']);}
  }
  else if(kind==='rank'){const e=await entity();s.barberIntent='rank';s.command={kind:'saveBarber',barberId:e.id,expectedVersion:e.version,name:e.name,rankId:e.rank_id??null};s.view='ranks';s.page=0;}
  else if(kind==='pickRank'&&s.command?.kind==='saveBarber'){if(a.id!==null)await activeEntity(c,'ranks',String(a.id));s.command.rankId=a.id===null?null:String(a.id);await beginReview();}
  else if(kind==='archive'){const e=await entity();s.command=s.table==='services'?{kind:'archiveService',serviceId:e.id,expectedVersion:e.version}:s.table==='ranks'?{kind:'archiveRank',rankId:e.id,expectedVersion:e.version}:{kind:'archiveBarber',barberId:e.id,expectedVersion:e.version};await beginReview();}
  else if(kind==='services'){await entity();s.view='services';s.page=0;}
  else if(kind==='pickService'){await activeEntity(c,'services',String(a.id));s.serviceId=String(a.id);s.view='service';}
  else if(kind==='tariff'){const e=await entity();if(!s.serviceId)refuse();beginInput(s.table==='ranks'?{kind:'setRankTariff',rankId:e.id,serviceId:s.serviceId!,expectedVersion:e.version,priceKopecks:0,durationMinutes:1}:{kind:'setBarberTariff',operation:'set',barberId:e.id,serviceId:s.serviceId!,expectedVersion:e.version,priceKopecks:0,durationMinutes:1},['priceKopecks','durationMinutes']);}
  else if(kind==='assign'||kind==='reset'){const e=await entity();if(!s.serviceId)refuse();s.command=kind==='assign'?{kind:'assignBarberService',barberId:e.id,expectedVersion:e.version,serviceId:s.serviceId!,assigned:a.assigned===true}:{kind:'setBarberTariff',operation:'reset',barberId:e.id,expectedVersion:e.version,serviceId:s.serviceId!};await beginReview();}
  else if(kind==='weekly'){await entity();s.view='weekday';}
  else if(kind==='weekday'){const e=await entity(),weekday=Number(a.day);if(!Number.isInteger(weekday)||weekday<1||weekday>7)refuse();beginInput({kind:'saveWeeklyHours',barberId:e.id,expectedVersion:e.version,weekday,intervals:[]},['intervals']);}
  else if(kind==='exception'){await entity();s.view='calendar';s.month=localDate(tx.now).slice(0,7);}
  else if(kind==='month'){calendarMonth(String(a.month),new Set());s.month=String(a.month);}
  else if(kind==='date'){const e=await entity();beginInput({kind:'saveDateException',barberId:e.id,expectedVersion:e.version,date:parseDate(String(a.date)),intervals:[]},['intervals']);}
  else if((kind==='dayOff'||kind==='restore')&&s.command&&(s.command.kind==='saveWeeklyHours'||s.command.kind==='saveDateException')){s.command.intervals=kind==='restore'&&s.command.kind==='saveDateException'?null:[];s.fields=[];await beginReview();}
  else if(kind==='horizon'){const d=await dependencies({kind:'setBookingHorizon',expectedVersion:1,days:30});beginInput({kind:'setBookingHorizon',expectedVersion:d.settings.version,days:d.settings.booking_horizon_days},['days']);}
  else if(kind==='invite'||kind==='revoke'||kind==='link'||kind==='showLink'){
   const e=await entity();s.command=kind==='invite'?{kind:'issueBarberInvite',barberId:e.id}:kind==='revoke'?{kind:'revokeInvite',barberId:e.id,invitationId:String(a.id)}:kind==='showLink'?{kind:'showPublicLink',barberId:e.id,expectedVersion:e.version}:{kind:'issuePublicLink',barberId:e.id,expectedVersion:e.version,replace:true};await beginReview();
  }
  else if(kind==='confirm'&&s.view==='review'&&s.command&&s.reviewReady){
   const fresh=await review(s.command);
   if(fresh.fingerprint!==s.fingerprint){
    await beginReview();notice='Данные изменились. Проверьте новый итог и подтвердите ещё раз.';
   }else{
    if(s.command.kind==='issueBarberInvite'){const id=await issueBarberInvite(actor,s.command.barberId,tx,options);await tx.query(`WITH audit AS (INSERT INTO audit_events(update_id,actor_id,kind,entity_id,created_at) VALUES($1,$2,'invite_issued',$3,$4)) INSERT INTO outbox(logical_key,update_id,kind,chat_id,payload,due_at) VALUES($5,$1,'invitation',$6,$7::jsonb,$4)`,[updateId,userId,id,tx.now,`invitation:${id}`,actor.telegramId,JSON.stringify({invitationId:id})]);result={entityId:id,status:'invite_issued',nextWake:tx.now};}
    else if(s.command.kind==='revokeInvite'){const id=await revokeInvite(actor,s.command.invitationId,tx);await tx.query('INSERT INTO audit_events(update_id,actor_id,kind,entity_id,created_at) VALUES($1,$2,$3,$4,$5)',[updateId,userId,'invite_revoked',id,tx.now]);result={entityId:id,status:'invite_revoked',nextWake:tx.now};}
    else result=await executeAdmin(c,s.command,options);
    if(result.conflicts){s.view='conflicts';s.conflicts=result.conflicts;s.page=0;}else{s.view='home';s.command=undefined;notice='Готово.';}
   }
  }
 }
 if(!stale&&input.text!==undefined&&s.view==='input'&&s.fields?.length&&s.command){
  const field=s.fields[0];try{
   const value=field==='name'?parseName(input.text):field==='priceKopecks'?parseRoubles(input.text):field==='durationMinutes'?parseMinutes(input.text):field==='days'?parseHorizon(input.text):parseIntervals(input.text);
   Object.assign(s.command,{[field]:value});s.fields.shift();
   if(!s.fields.length){if(s.command.kind==='saveBarber'){s.view='ranks';s.page=0;}else await beginReview();}
  }catch(error){if(!(error instanceof DomainError))throw error;notice='Некорректное значение. Попробуйте ещё раз.';}
 }
 let text='',rows:ScreenButton[][]=[];
 if(s.view==='home'){text='Управление';rows=[[button('Услуги',{kind:'list',table:'services'})],[button('Ранги',{kind:'list',table:'ranks'})],[button('Мастера',{kind:'list',table:'barbers'})],[button('Горизонт записи',{kind:'horizon'})]];}
 else if(s.view==='list'){text=labels[s.table!];rows=[...selectionRows(await list(s.table!),'card',s.table!),[button('Создать',{kind:'create'})],back()];}
 else if(s.view==='card'){
  const e=await entity();text=`${labels[s.table!]}\n${e.name}`;rows=[[button('Изменить название / имя',{kind:'rename'})],[button('Архивировать',{kind:'archive'})]];
  if(s.table==='ranks'||s.table==='barbers')rows.push([button('Услуги и тарифы',{kind:'services'})]);
  if(s.table==='barbers'){
   const d=await dependencies({kind:'issueBarberInvite',barberId:e.id});text+=`\nРанг: ${d.barberRank?.name??'без ранга'}`;
   const schedule=await loadSchedule(e.id,tx);text+='\n'+dayNames.map((day,i)=>`${day}: ${intervals(schedule.weekly[i+1]??[])}`).join('\n');
   rows.push([button('Изменить ранг',{kind:'rank'})],[button('Недельный график',{kind:'weekly'}),button('Исключение даты',{kind:'exception'})],[button('Пригласить барбера',{kind:'invite'})]);
   for(const invite of d.invitations.slice(0,5))rows.push([button(`Отозвать приглашение до ${new Date(invite.expires_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})}`,{kind:'revoke',id:invite.id})]);
   rows.push([button('Показать ссылку',{kind:'showLink'})],[button('Создать / заменить ссылку',{kind:'link'})]);
  }rows.push(back());
 }
 else if(s.view==='ranks'){text='Выберите ранг мастера.';rows=[...selectionRows(await list('ranks'),'pickRank','ranks'),[button('Без ранга',{kind:'pickRank',id:null})],back()];}
 else if(s.view==='services'){text='Выберите услугу.';rows=[...selectionRows(await list('services'),'pickService','services'),back()];}
 else if(s.view==='service'){
  const e=await entity(),service=await activeEntity(c,'services',s.serviceId!);const d=await dependencies(s.table==='ranks'?{kind:'setRankTariff',rankId:e.id,serviceId:service.id,expectedVersion:e.version,priceKopecks:0,durationMinutes:1}:{kind:'assignBarberService',barberId:e.id,serviceId:service.id,expectedVersion:e.version,assigned:true});
  text=`${e.name}\n${service.name}\nРанговый тариф: ${d.rankTariff?`${d.rankTariff.price_kopecks/100} ₽, ${d.rankTariff.duration_minutes} мин.`:'не задан'}`;
  rows=[[button('Задать тариф',{kind:'tariff'})]];if(s.table==='barbers'){text+=`\nНазначение: ${d.assignment?'да':'нет'}\nИндивидуальный тариф: ${d.override?`${d.override.price_kopecks/100} ₽, ${d.override.duration_minutes} мин.`:'нет'}`;rows.push([button(d.assignment?'Убрать назначение':'Назначить услугу',{kind:'assign',assigned:!d.assignment})],[button('Сбросить индивидуальный тариф',{kind:'reset'})]);}rows.push(back());
 }
 else if(s.view==='weekday'){text='Выберите день недели.';rows=[...dayNames.map((name,i)=>[button(name,{kind:'weekday',day:i+1})]),back()];}
 else if(s.view==='calendar'){
  const cal=calendarMonth(s.month,new Set(Array.from({length:31},(_,i)=>`${s.month}-${String(i+1).padStart(2,'0')}`)));text=`Выберите дату: ${s.month}`;
  for(let i=0;i<cal.days.length;i+=7)rows.push(cal.days.slice(i,i+7).map(d=>button(d.label,d.date?{kind:'date',date:d.date}:{kind:'noop'})));
  rows.push([button('‹',{kind:'month',month:cal.previous}),button('›',{kind:'month',month:cal.next})],back());
 }
 else if(s.view==='input'){
  const field=s.fields?.[0];text=field==='name'?'Введите название / имя одной строкой (1–80 символов).':field==='priceKopecks'?'Введите цену в рублях (например 1500,50).':field==='durationMinutes'?'Введите длительность в минутах, целое положительное число.':field==='days'?'Введите горизонт записи в днях (1–365).':'Введите рабочие интервалы HH:MM–HH:MM через запятую. Промежутки между интервалами — перерывы.';
  if(s.command?.kind==='saveWeeklyHours')text=`${dayNames[s.command.weekday-1]}\n${text}`;
  if(s.command?.kind==='saveDateException')text=`${s.command.date}\n${text}`;
  if(field==='intervals'){rows.push([button('Выходной',{kind:'dayOff'})]);if(s.command?.kind==='saveDateException')rows.push([button('Вернуться к недельному графику',{kind:'restore'})]);}rows.push(back());
 }
 else if(s.view==='review'){text=s.review!;rows=[[button('Подтвердить',{kind:'confirm'})],back()];}
 else if(s.view==='conflicts'){
  const conflicts=s.conflicts??[];text='Изменения не сохранены. Конфликты (МСК):\n'+conflicts.slice(s.page*5,s.page*5+5).map(x=>`${x.kind==='visit'?'Запись':'Перенос'}: ${new Date(x.start).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} — ${new Date(x.end).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})}`).join('\n');
  rows=[...(s.page?[[button('‹',{kind:'page',page:s.page-1})]]:[]),...(conflicts.length>(s.page+1)*5?[[button('›',{kind:'page',page:s.page+1})]]:[]),back()];
 }
 const prefix=textRequest!==undefined?s.textNotice:notice;
 const display=(prefix?prefix+'\n\n':'')+text,pages=textPages(display),key=await hashToken(display);
 if(textRequest!==undefined&&s.textKey===key){
  s.textPage=Math.min(textRequest,pages.length-1,(s.textSeen??0)+1);
  s.textSeen=Math.max(s.textSeen??0,s.textPage);
 }else{s.textPage=0;s.textSeen=0;}
 s.textKey=key;s.textNotice=prefix;
 s.reviewReady=s.view==='review'&&s.textPage===pages.length-1&&s.textSeen>=pages.length-1;
 if(s.view==='review'&&!s.reviewReady)rows=rows.map(r=>r.filter(b=>b.action.kind!=='confirm')).filter(r=>r.length);
 if(pages.length>1){const nav:ScreenButton[]=[];if(s.textPage>0)nav.push(button('Назад по тексту',{kind:'textPage',page:s.textPage-1,key}));if(s.textPage<pages.length-1)nav.push(button('Далее по тексту',{kind:'textPage',page:s.textPage+1,key}));rows.push(nav);}
 text=(pages.length>1?`Страница ${s.textPage+1}/${pages.length}\n\n`:'')+pages[s.textPage];
 await tx.query("UPDATE outbox SET status='cancelled',claim_token=NULL,lease_until=NULL,version=version+1 WHERE draft_id=$1 AND status IN ('pending','leased')",[row.id]);
 row=(await tx.query<Row>('UPDATE drafts SET barber_id=$2,state=$3::jsonb,version=version+1 WHERE id=$1 RETURNING *',[row.id,null,JSON.stringify(s)]))[0];
 const buttons=rows.flat().map(b=>({...b,id:crypto.randomUUID()}));
 await tx.query(`INSERT INTO callbacks(id,user_id,draft_id,draft_version,action,expires_at) SELECT x.id,$1,$2,$3,x.action,LEAST($4::timestamptz,$5::timestamptz+interval '30 minutes') FROM jsonb_to_recordset($6::jsonb) AS x(id uuid,action jsonb)`,[userId,row.id,row.version,row.expires_at,tx.now,JSON.stringify(buttons)]);
 let i=0;await tx.query(`INSERT INTO outbox(logical_key,update_id,kind,chat_id,payload,due_at,draft_id,draft_version) SELECT $1,$2,'client_screen',u.telegram_id,$3::jsonb,$4,$5,$6 FROM telegram_users u WHERE u.id=$7`,[`admin:${updateId}`,updateId,JSON.stringify({adminScreen:true,text,reply_markup:{inline_keyboard:rows.map(r=>r.map(b=>({text:b.text,callback_data:buttons[i++].id})))}}),tx.now,row.id,row.version,userId]);
 return result??{status:stale?'stale_callback':'admin_screen',nextWake:tx.now};
}
