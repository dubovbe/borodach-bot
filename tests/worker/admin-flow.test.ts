import {expect,it} from 'vitest';
import {Repository} from '../../src/db/repository';
import {clientDatabase} from './client-db';
it('admin menu is reachable from private start and a foreign actor cannot use its button',async()=>{
 const f=clientDatabase();f.user('201').roles=['client','admin'];const repo=new Repository(f.database);
 await repo.execute({telegramId:'201'},{kind:'start',payload:null},'9900');
 const screen=f.outbox.find(o=>o.kind==='client_screen'&&o.status==='pending');
 const rows=screen.payload.reply_markup.inline_keyboard.slice(1);
 expect(rows.map((r:any[])=>r.length)).toEqual([1,1,1,1,1,1]);
 expect(rows.map((r:any[])=>r[0].text)).toEqual(['📋 Мои записи','⚙️ Настройки','💈 Рабочее место','📊 Статистика','🔄 Переносы','🛠 Управление']);
 expect(rows.map((r:any[])=>f.callbacks.get(r[0].callback_data)?.action)).toEqual([{kind:'bookings'},{kind:'settings'},{kind:'staff',scope:'staff'},{kind:'staffReport',scope:'staff'},{kind:'staffTransfers'},{kind:'admin'}]);
 const button=screen.payload.reply_markup.inline_keyboard.flat().find((b:any)=>b.text==='🛠 Управление');expect(button).toBeDefined();
 expect((await repo.execute({telegramId:'100'},{kind:'clientAction',callbackId:button.callback_data},'9901')).status).toBe('forbidden');
 expect((await repo.execute({telegramId:'201'},{kind:'clientAction',callbackId:button.callback_data},'9902')).status).toBe('admin_screen');
 expect(f.outbox.find(o=>o.kind==='client_screen'&&o.status==='pending').payload.text).toContain('Управление');
});
import {adminDatabase} from './admin-db';
import {Outbox} from '../../src/notifications/outbox';
async function adminFlow(){
 const f=adminDatabase();f.user('201').roles=['client','admin'];const repo=new Repository(f.database,'',{invitationSecret:'synthetic-Stage9-secret-0123456789-ABCDEFG',botUsername:'test_bot'});let update=10000;
 const run=(command:any,id='201')=>repo.execute({telegramId:id},command,String(update++));
 const screen=()=>f.outbox.find(o=>o.kind==='client_screen'&&o.status==='pending'&&o.chat_id==='201')?.payload;
 const button=(label:string)=>{const b=screen()?.reply_markup.inline_keyboard.flat().find((b:any)=>b.text===label||b.text.includes(label));expect(b,JSON.stringify(screen())).toBeDefined();return b.callback_data;};
 const click=(label:string)=>run({kind:'clientAction',callbackId:button(label)});
 const text=(text:string)=>run({kind:'saveDraftInput',text});
 await run({kind:'start',payload:null});await click('Управление');return {...f,repo,run,screen,button,click,text};
}
it('admin creates service rank and barber only after reviews with invalid text retaining form',async()=>{
 const f=await adminFlow();await f.click('Услуги');await f.click('Создать');await f.text('');expect(f.services.size).toBe(1);await f.text('Новая услуга');expect(f.screen().text).toContain('Проверьте');expect(f.services.size).toBe(1);await f.click('Подтвердить');expect([...f.services.values()].some(e=>e.name==='Новая услуга')).toBe(true);
 await f.click('Ранги');await f.click('Создать');await f.text('Новый ранг');await f.click('Подтвердить');
 await f.click('Мастера');await f.click('Создать');await f.text('Анна');await f.click('Новый ранг');expect(f.screen().text).toContain('Анна');expect(f.barbers.size).toBe(1);await f.click('Подтвердить');expect([...f.barbers.values()].find(e=>e.name==='Анна').rank_id).toBe([...f.ranks.values()].find(e=>e.name==='Новый ранг').id);
});
it('admin assignment rank tariff override and explicit reset are reachable and reviewed',async()=>{
 const f=await adminFlow();await f.click('Ранги');await f.click('Тестовый ранг');await f.click('Услуги и тарифы');await f.click('Тестовая стрижка');await f.click('Задать тариф');await f.text('1500,01');await f.text('0');expect(f.rankTariffs.size).toBe(0);await f.text('75');expect(f.rankTariffs.size).toBe(0);expect(f.screen().text).toContain('1500.01');await f.click('Подтвердить');expect([...f.rankTariffs.values()][0]).toMatchObject({price_kopecks:150001,duration_minutes:75});
 await f.click('Мастера');await f.click('Вымышленный мастер');await f.click('Услуги и тарифы');await f.click('Тестовая стрижка');await f.click('Назначить услугу');expect(f.assignments.size).toBe(0);await f.click('Подтвердить');expect(f.assignments.size).toBe(1);
 await f.click('Мастера');await f.click('Вымышленный мастер');await f.click('Услуги и тарифы');await f.click('Тестовая стрижка');await f.click('Задать тариф');await f.text('0');await f.text('1441');await f.click('Подтвердить');expect([...f.overrides.values()][0]).toMatchObject({price_kopecks:0,duration_minutes:1441});
 await f.click('Мастера');await f.click('Вымышленный мастер');await f.click('Услуги и тарифы');await f.click('Тестовая стрижка');await f.click('Сбросить');expect(f.overrides.size).toBe(1);await f.click('Подтвердить');expect(f.overrides.size).toBe(0);
});
it('changed review dependency needs another explicit confirmation and lost admin cannot save',async()=>{
 const f=await adminFlow();await f.click('Услуги');await f.click('Тестовая стрижка');await f.click('Изменить');await f.text('Новое название');const e=[...f.services.values()][0];e.name='Изменено другим админом';e.version++;
 await f.click('Подтвердить');expect(e.name).toBe('Изменено другим админом');expect(f.screen().text).toContain('Данные изменились');expect(f.screen().text).toContain('Изменено другим админом');await f.click('Подтвердить');expect(e.name).toBe('Новое название');
 await f.click('Услуги');await f.click('Новое название');await f.click('Архивировать');const callbackId=f.button('Подтвердить');f.user('201').roles=['client'];expect((await f.run({kind:'clientAction',callbackId})).status).toBe('forbidden');expect(e.archived_at).toBeNull();
});
it('admin screens are suppressed by delivery after role loss and contact stays in admin flow',async()=>{
 const f=await adminFlow();await f.run({kind:'updateContact',contact:{userId:'201',phone:'+79123456789'}});expect([...f.drafts.values()][0].state.scope).toBe('admin');f.user('201').roles=['client'];const delivered:any[]=[];await new Outbox(f.database,{send:async d=>{delivered.push(d);return {messageId:'1'};}}).deliver(f.now,5);expect(delivered.every(d=>!d.payload.text.includes('Управление'))).toBe(true);
});
it('runtime mutation versions are required and positive integers before any write',async()=>{
 const f=await adminFlow();for(const expectedVersion of [undefined,NaN,0,1.2]){expect((await f.run({kind:'setRankTariff',rankId:'00000000-0000-4000-8000-000000000001',serviceId:'00000000-0000-4000-8000-000000000003',expectedVersion,priceKopecks:100,durationMinutes:30})).status).toBe('invalid_input');}expect(f.rankTariffs.size).toBe(0);
});
it('weekly and real-date forms reject invalid ranges and show day off and restore reviews',async()=>{
 const f=await adminFlow();await f.click('Мастера');await f.click('Вымышленный мастер');await f.click('Недельный график');await f.click('Понедельник');await f.text('12:00-09:00');expect(f.screen().text).toContain('Некорректное');await f.text('09:00-12:00,11:00-13:00');expect(f.screen().text).toContain('Некорректное');await f.text('09:00-12:00,13:00-18:00');expect(f.screen().text).toContain('Проверьте');expect(f.screen().text).toContain('Понедельник');expect(f.screen().text).toContain('09:00');expect([...f.barbers.values()][0].version).toBe(1);
 await f.click('К управлению');await f.click('Мастера');await f.click('Вымышленный мастер');await f.click('Исключение даты');await f.click('›');expect(f.screen().text).toContain('2026-12');await f.click('10');await f.click('Выходной');expect(f.screen().text).toContain('2026-12-10');expect(f.screen().text).toContain('Выходной');
 await f.click('К управлению');await f.click('Мастера');await f.click('Вымышленный мастер');await f.click('Исключение даты');await f.click('10');await f.click('Вернуться к недельному графику');expect(f.screen().text).toContain('2026-11-10');expect(f.screen().text).toContain('Вернуться к недельному графику');
});
it('all entity lists page at five with bounded opaque callbacks and full entity names',async()=>{
 const f=await adminFlow();for(let i=0;i<12;i++){const id=crypto.randomUUID();f.services.set(id,{id,name:`Услуга ${i}`,version:1,archived_at:null});}await f.click('Услуги');const first=f.screen().reply_markup.inline_keyboard.flat();expect(first.filter((b:any)=>b.text.startsWith('Услуга ')||b.text==='Тестовая стрижка')).toHaveLength(5);for(const b of first){expect(b.text.length).toBeLessThanOrEqual(100);expect(b.callback_data).toMatch(/^[a-f0-9-]{36}$/);expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);}await f.click('›');expect(f.screen().text.length).toBeLessThanOrEqual(4096);await f.click('‹');expect(f.screen().reply_markup.inline_keyboard.flat().some((b:any)=>b.text==='‹')).toBe(false);
});
it('expired foreign and replaced admin callbacks cannot mutate and start exits the admin form',async()=>{
 const f=await adminFlow();await f.click('Услуги');await f.click('Тестовая стрижка');await f.click('Изменить');await f.text('Проверка');const submit=f.button('Подтвердить'),draft=[...f.drafts.values()][0],expiry=draft.expires_at;
 expect((await f.run({kind:'clientAction',callbackId:submit},'200')).status).toBe('forbidden');expect([...f.services.values()][0].name).toBe('Тестовая стрижка');
 await f.run({kind:'start',payload:null});expect([...f.drafts.values()][0].state.scope).not.toBe('admin');expect((await f.run({kind:'clientAction',callbackId:submit})).status).toBe('stale_callback');
 await f.click('Управление');[...f.drafts.values()][0].expires_at=f.now;expect((await f.run({kind:'saveDraftInput',text:'Unexpected'})).status).toBe('stale_callback');expect(expiry).toBe('2026-11-06T04:30:00.000Z');
});
it('link replacement and invitation issue require meaningful explicit review',async()=>{
 const f=await adminFlow();[...f.barbers.values()][0].public_token_hash='b'.repeat(64);await f.click('Мастера');await f.click('Вымышленный мастер');await f.click('Создать / заменить ссылку');expect(f.screen().text).toContain('Предыдущая ссылка перестанет работать');expect(f.outbox.some(o=>o.kind==='public_link')).toBe(false);
 await f.click('К управлению');await f.click('Мастера');await f.click('Вымышленный мастер');await f.click('Пригласить барбера');expect(f.screen().text).toContain('24 часа');expect(f.outbox.some(o=>o.kind==='invitation')).toBe(false);
});
it('old client callbacks during admin form safely refresh admin instead of invoking client renderer',async()=>{
 const f=await adminFlow();const old=[...f.callbacks.values()].find(cb=>cb.action.kind==='settings');const before=[...f.drafts.values()][0].version;
 const result=await f.run({kind:'clientAction',callbackId:old.id});expect(result.status).toBe('stale_callback');expect([...f.drafts.values()][0].state.scope).toBe('admin');expect([...f.drafts.values()][0].version).toBe(before+1);expect(f.screen().text).toContain('Управление');
});

it('admin role loss refuses text without exposing another admin form screen',async()=>{const f=await adminFlow();await f.click('Услуги');await f.click('Создать');f.user('201').roles=['client'];expect((await f.text('Not saved')).status).toBe('forbidden');expect(f.services.size).toBe(1);});
import {publicBookingToken,hashToken} from '../../src/identity/service';
it('managed public link review offers current stable link without promising repeated rotation',async()=>{
 const f=await adminFlow(),barber=[...f.barbers.values()][0];barber.public_token_hash=await hashToken(await publicBookingToken(barber.id,'synthetic-Stage9-secret-0123456789-ABCDEFG'));
 await f.click('Мастера');await f.click('Вымышленный мастер');await f.click('Создать / заменить ссылку');expect(f.screen().text).toContain('действующую ссылку');expect(f.screen().text).not.toContain('перестанет работать');
});
async function deliveredAdmin(f:Awaited<ReturnType<typeof adminFlow>>){
 const sent:any[]=[];await new Outbox(f.database,{send:async d=>{sent.push(d.payload);return {messageId:'1'};}}).deliver(f.now,5);
 const screen=[...sent].reverse().find(p=>p.reply_markup?.inline_keyboard);expect(screen,'admin screen must pass real Outbox delivery').toBeDefined();expect(screen.text.length).toBeLessThanOrEqual(4096);
 const buttons=screen.reply_markup.inline_keyboard.flat();return {...screen,buttons,click:async(label:string)=>{const b=buttons.find((b:any)=>b.text===label||b.text.includes(label));expect(b,JSON.stringify(screen)).toBeDefined();return f.run({kind:'clientAction',callbackId:b.callback_data});}};
}
it('concurrent owner change before initial tariff review yields deliverable actionable review and explicit save once',async()=>{
 const f=await adminFlow();await f.click('Ранги');await f.click('Тестовый ранг');await f.click('Услуги и тарифы');await f.click('Тестовая стрижка');await f.click('Задать тариф');await f.text('1700,12');const rank=[...f.ranks.values()][0];rank.name='Fresh rank';rank.version++;
 await f.text('83');const review=await deliveredAdmin(f);expect(review.text).toContain('Fresh rank');const submit=review.buttons.find((b:any)=>b.text==='Подтвердить').callback_data;expect((await review.click('Подтвердить')).status).toBe('saved');expect([...f.rankTariffs.values()][0]).toMatchObject({price_kopecks:170012,duration_minutes:83});expect(rank.version).toBe(3);expect((await f.run({kind:'clientAction',callbackId:submit})).status).toBe('stale_callback');expect(rank.version).toBe(3);await deliveredAdmin(f);
});
it.each(['before initial review','after initial review'])('rank-only review preserves concurrent barber rename %s through delivered confirmation',async timing=>{
 const f=await adminFlow(),barber=[...f.barbers.values()][0],rankId=crypto.randomUUID();f.ranks.set(rankId,{id:rankId,name:'New rank',version:1,archived_at:null});await f.click('Мастера');await f.click('Вымышленный мастер');await f.click('Изменить ранг');
 if(timing==='before initial review'){barber.name='Concurrent rename';barber.version++;}
 await f.click('New rank');let review=await deliveredAdmin(f);
 if(timing==='after initial review'){barber.name='Concurrent rename';barber.version++;expect((await review.click('Подтвердить')).status).toBe('admin_screen');review=await deliveredAdmin(f);expect(review.text).toContain('Данные изменились');}
 expect(review.text).toContain('Concurrent rename');expect((await review.click('Подтвердить')).status).toBe('saved');expect(barber.name).toBe('Concurrent rename');expect(barber.rank_id).toBe(rankId);await deliveredAdmin(f);
});
const denseDay=(count:number,start=0)=>Array.from({length:count},(_,i)=>({startMinute:start+i*2,endMinute:start+i*2+1}));
const renderIntervals=(items:{startMinute:number;endMinute:number}[])=>items.map(i=>`${String(Math.floor(i.startMinute/60)).padStart(2,'0')}:${String(i.startMinute%60).padStart(2,'0')}–${String(Math.floor(i.endMinute/60)).padStart(2,'0')}:${String(i.endMinute%60).padStart(2,'0')}`).join(', ');
it('dense seven-day barber card pages survive real Outbox and keep management buttons reachable',async()=>{
 const f=await adminFlow();for(let day=1;day<=7;day++)f.weeklyHours.set(day,denseDay(50,540));await f.click('Мастера');await f.click('Вымышленный мастер');
 let card=await deliveredAdmin(f);const chunks:string[]=[];for(let n=0;n<10;n++){chunks.push(card.text.replace(/^Страница \d+\/\d+\n\n/,''));if(!card.buttons.some((b:any)=>b.text==='Далее по тексту'))break;await card.click('Далее по тексту');card=await deliveredAdmin(f);}
 expect(chunks.length).toBeGreaterThan(1);const full=chunks.join('');for(const day of ['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'])expect(full).toContain(day);expect(full.match(/10:38–10:39/g)).toHaveLength(7);await card.click('Недельный график');expect((await deliveredAdmin(f)).text).toContain('Выберите день недели');
});
it('long current and proposed day reviews page completely with notice and save canonical intervals only after final page',async()=>{
 const f=await adminFlow(),old=denseDay(250,0),proposed=denseDay(250,600);f.weeklyHours.set(1,old);await f.click('Мастера');await f.click('Вымышленный мастер');await f.click('Недельный график');await f.click('Понедельник');const prompt=await deliveredAdmin(f);expect(prompt.text).toContain('Введите рабочие интервалы');await f.text(renderIntervals(proposed));
 let page=await deliveredAdmin(f);expect(page.buttons.some((b:any)=>b.text==='Подтвердить')).toBe(false);const staleNext=page.buttons.find((b:any)=>b.text==='Далее по тексту').callback_data;
 const chunks:string[]=[];for(let n=0;n<10;n++){chunks.push(page.text.replace(/^Страница \d+\/\d+\n\n/,''));if(!page.buttons.some((b:any)=>b.text==='Далее по тексту'))break;await page.click('Далее по тексту');page=await deliveredAdmin(f);}
 const full=chunks.join('');expect(full).toContain(renderIntervals(old));expect(full).toContain(renderIntervals(proposed));expect(f.weeklyHours.get(1)).toEqual(old);expect(page.buttons.some((b:any)=>b.text==='Подтвердить')).toBe(true);
 await page.click('Назад по тексту');page=await deliveredAdmin(f);expect(page.buttons.some((b:any)=>b.text==='Подтвердить')).toBe(false);await page.click('Далее по тексту');page=await deliveredAdmin(f);expect(page.buttons.some((b:any)=>b.text==='Подтвердить')).toBe(true);
 // A concurrent change invalidates completion and requires reading the refreshed review.
 [...f.barbers.values()][0].version++;expect((await page.click('Подтвердить')).status).toBe('admin_screen');page=await deliveredAdmin(f);expect(page.text).toContain('Данные изменились');expect(page.buttons.some((b:any)=>b.text==='Подтвердить')).toBe(false);
 await f.run({kind:'clientAction',callbackId:staleNext});page=await deliveredAdmin(f);expect(page.text).toContain('Кнопка устарела');expect(page.text.length).toBeLessThanOrEqual(4096);
 for(let n=0;n<10&&page.buttons.some((b:any)=>b.text==='Далее по тексту');n++){await page.click('Далее по тексту');page=await deliveredAdmin(f);}
 expect((await page.click('Подтвердить')).status).toBe('schedule_changed');expect(f.weeklyHours.get(1)).toEqual(proposed);await deliveredAdmin(f);
});
