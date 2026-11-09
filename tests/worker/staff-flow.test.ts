import {expect,it} from 'vitest';
import {Repository} from '../../src/db/repository';
import {clientDatabase} from './client-db';
import {Outbox} from '../../src/notifications/outbox';
it.each(['200','201'])('workspace navigation keeps readable rows and original actions for %s',async id=>{
 const f=clientDatabase();if(id==='201')f.user(id).roles=['client','admin'];const repo=new Repository(f.database);
 await repo.execute({telegramId:id},{kind:'start',payload:null},'112000');
 const entry=[...f.callbacks.values()].find(cb=>cb.action.kind==='staff');expect(entry).toBeDefined();
 await repo.execute({telegramId:id},{kind:'clientAction',callbackId:entry.id},'112001');
 const rows=f.outbox.find(o=>o.kind==='client_screen'&&o.status==='pending'&&o.chat_id===id).payload.reply_markup.inline_keyboard;
 expect(rows.map((r:any[])=>r.map(b=>b.text))).toEqual([['📅 Сегодня','🗓 Неделя'],['📆 Выбрать день'],['📥 Заявки'],['✍️ Записать клиента'],['📊 Статистика'],...(id==='201'?[['Фильтр мастера']]:[])]);
 expect(rows.flat().map((b:any)=>f.callbacks.get(b.callback_data)?.action)).toEqual([{kind:'today',scope:'staff'},{kind:'week',scope:'staff'},{kind:'date',scope:'staff'},{kind:'pending',scope:'staff'},{kind:'manual',scope:'staff'},{kind:'report',scope:'staff'},...(id==='201'?[{kind:'masters',scope:'staff'}]:[])]);
});
async function workspace(id='200'){
 const f=clientDatabase();if(id==='201')f.user(id).roles=['client','admin'];const repo=new Repository(f.database);let update=111000;
 const run=(command:any,actor=id)=>repo.execute({telegramId:actor},command,String(update++));
 const screen=()=>f.outbox.find(o=>o.kind==='client_screen'&&o.status==='pending'&&o.chat_id===id)?.payload;
 const button=(label:string)=>{const b=screen()?.reply_markup.inline_keyboard.flat().find((b:any)=>b.text===label);expect(b,JSON.stringify(screen())).toBeDefined();return b.callback_data;};
 const click=(label:string)=>run({kind:'clientAction',callbackId:button(label)});
 await run({kind:'start',payload:null});const entry=button('💈 Рабочее место'),oldClient=button('⚙️ Настройки');await click('💈 Рабочее место');return {...f,repo,run,screen,button,click,entry,oldClient};
}
it('staff workspace entry is reachable from private start and actor-bound',async()=>{
 const f=clientDatabase(),repo=new Repository(f.database);
 await repo.execute({telegramId:'200'},{kind:'start',payload:null},'110000');
 const screen=f.outbox.find(o=>o.kind==='client_screen'&&o.status==='pending');
 const button=screen.payload.reply_markup.inline_keyboard.flat().find((b:any)=>b.text==='💈 Рабочее место');
 expect(button).toBeDefined();
 expect((await repo.execute({telegramId:'100'},{kind:'clientAction',callbackId:button.callback_data},'110001')).status).toBe('forbidden');
});
it('day/week and private zero reports remain actor scoped and label service value accurately',async()=>{
 const f=await workspace();await f.click('📅 Сегодня');expect(f.screen().text).toContain('2026-11-06');expect(f.screen().text).toContain('Записей нет');
 expect(f.callbacks.get(f.button('⬅️ К рабочему месту'))?.action).toEqual({kind:'home',scope:'staff'});
 await f.click('⬅️ К рабочему месту');await f.click('📆 Выбрать день');expect(f.screen().text).toContain('Введите дату YYYY-MM-DD');
 await f.run({kind:'saveDraftInput',text:'2026-11-07'});expect(f.screen().text).toContain('2026-11-07');
 await f.click('⬅️ К рабочему месту');await f.click('🗓 Неделя');expect(f.screen().text).toContain('2026-11-02 — 2026-11-08');
 await f.click('⬅️ К рабочему месту');await f.click('📊 Статистика');expect(f.screen().text).toContain('Стоимость оказанных услуг: 0');expect(f.screen().staffScreen).toMatchObject({mode:'barber',barberId:'00000000-0000-4000-8000-000000000002'});
 await f.click('За период');await f.run({kind:'saveDraftInput',text:'2026-02-29 2026-11-07'});expect(f.screen().text).toContain('Некорректное');
});
it.each(['200','201'])('delivery suppresses private empty report after current authority loss for %s',async id=>{
 const f=await workspace(id);await f.click('📊 Статистика');f.user(id).roles=['client'];const sent:any[]=[];
 await new Outbox(f.database,{send:async d=>{sent.push(d);return {messageId:'private'};}}).deliver(f.now,5);
 expect(sent).toHaveLength(0);
});
it('admin all-report marker cannot downgrade to a barber report at delivery',async()=>{
 const f=await workspace('201');await f.click('📊 Статистика');expect(f.screen().staffScreen.mode).toBe('admin');f.user('201').roles=['barber'];
 const sent:any[]=[];await new Outbox(f.database,{send:async d=>{sent.push(d);return {messageId:'private'};}}).deliver(f.now,5);expect(sent).toHaveLength(0);
});
it('stale client action refreshes current staff screen, and own contact never enters the manual customer fields',async()=>{
 const f=await workspace();expect((await f.run({kind:'clientAction',callbackId:f.oldClient})).status).toBe('stale_callback');expect(f.screen().text).toContain('Рабочее место');
 await f.click('✍️ Записать клиента');await f.click('☐ Тестовая стрижка');await f.click('Далее');await f.run({kind:'saveDraftInput',text:'Ручной Клиент'});
 await f.run({kind:'updateContact',contact:{userId:'200',phone:'+79123456789'}});
 const state=[...f.drafts.values()][0].state;expect(state).toMatchObject({scope:'staff',view:'input',input:'phone',name:'Ручной Клиент'});expect(state.phone).toBeUndefined();
});
it('manual final review binds all current terms and re-review removes the old confirmation capability',async()=>{
 const f=await workspace();await f.click('✍️ Записать клиента');await f.click('☐ Тестовая стрижка');await f.click('Далее');
 await f.run({kind:'saveDraftInput',text:'Ручной Клиент'});await f.run({kind:'saveDraftInput',text:'8 912 345 61 01'});await f.click('6');await f.click('07:00');
 expect(f.screen().text).toContain('Мастер: Вымышленный мастер');expect(f.screen().text).toContain('Ручной Клиент');expect(f.screen().text).toContain('+79123456101');expect(f.screen().text).toContain('1500.00 ₽');
 const old=f.button('Подтвердить');f.setPrice(170000);expect((await f.run({kind:'clientAction',callbackId:old})).status).toBe('staff_screen');expect(f.screen().text).toContain('Данные изменились');expect(f.screen().text).toContain('1700.00 ₽');expect(f.visits.size).toBe(0);
 expect((await f.run({kind:'clientAction',callbackId:old})).status).toBe('stale_callback');expect(f.visits.size).toBe(0);
});
it('staff workspace shows today/week/manual/report controls and resumes after own contact',async()=>{
 const f=clientDatabase(),repo=new Repository(f.database);let update=110100;
 const run=(command:any)=>repo.execute({telegramId:'200'},command,String(update++));
 const screen=()=>f.outbox.find(o=>o.kind==='client_screen'&&o.status==='pending'&&o.chat_id==='200')?.payload;
 const click=async(label:string)=>{const b=screen()?.reply_markup.inline_keyboard.flat().find((b:any)=>b.text===label);expect(b,JSON.stringify(screen())).toBeDefined();return run({kind:'clientAction',callbackId:b.callback_data});};
 await run({kind:'start',payload:null});expect((await click('💈 Рабочее место')).status).toBe('staff_screen');
 const rows=screen().reply_markup.inline_keyboard;
 expect(rows.map((r:any[])=>r.map(b=>b.text))).toEqual([['📅 Сегодня','🗓 Неделя'],['📆 Выбрать день'],['📥 Заявки'],['✍️ Записать клиента'],['📊 Статистика']]);
 expect(rows.flat().map((b:any)=>f.callbacks.get(b.callback_data)?.action)).toEqual([{kind:'today',scope:'staff'},{kind:'week',scope:'staff'},{kind:'date',scope:'staff'},{kind:'pending',scope:'staff'},{kind:'manual',scope:'staff'},{kind:'report',scope:'staff'}]);
 await run({kind:'updateContact',contact:{userId:'200',phone:'+79123456789'}});
 expect([...f.drafts.values()].find(d=>d.user_id===f.user('200').id).state.scope).toBe('staff');
});
async function manualCalendar(){
 const f=await workspace();await f.click('✍️ Записать клиента');await f.click('☐ Тестовая стрижка');await f.click('Далее');
 await f.run({kind:'saveDraftInput',text:'Ручной Клиент'});await f.run({kind:'saveDraftInput',text:'8 912 345 61 01'});return f;
}
it.each([['2026-12',1,['31']],['2027-03',4,['29','30','31']]] as const)('manual month %s exposes its final available days outside client horizon',async(month,steps,days)=>{
 const f=await manualCalendar();for(let n=0;n<steps;n++)await f.click('›');expect(f.screen().text).toContain(month);
 for(const day of days)expect(f.button(day)).toBeDefined();
 await f.click('31');expect(f.screen().text).toContain(`${month}-31`);expect(f.button('00:00')).toBeDefined();
});
it('report renders maximum safe integer kopecks exactly in its actual screen',async()=>{
 const f=await workspace();f.setReportValue('9007199254740991');await f.click('📊 Статистика');
 expect(f.screen().text).toContain('Стоимость оказанных услуг: 90071992547409.91 ₽');
});
it('occupied manual slot after review recovers fresh usable times preserving contact and rejecting old confirmation',async()=>{
 const f=await manualCalendar();await f.click('6');await f.click('07:00');const old=f.button('Подтвердить'),draft=[...f.drafts.values()][0],version=draft.version;
 const id=crypto.randomUUID();f.visits.set(id,{id,client_id:f.user('100').client,barber_id:'00000000-0000-4000-8000-000000000002',status:'confirmed',start_at:'2026-11-06T04:00:00.000Z',end_at:'2026-11-06T05:00:00.000Z',items:[]});
 expect((await f.run({kind:'clientAction',callbackId:old})).status).toBe('staff_screen');
 expect(f.screen().text).toContain('Выберите время');expect(f.button('08:00')).toBeDefined();expect(f.screen().reply_markup.inline_keyboard.flat().some((b:any)=>b.text==='Подтвердить')).toBe(false);
 expect(draft.version).toBeGreaterThan(version);expect(draft.state).toMatchObject({view:'times',name:'Ручной Клиент',phone:'+79123456101'});
 for(const key of ['start','quote','review'])expect(draft.state[key]).toBeUndefined();expect(draft.state.reviewReady).toBe(false);expect(f.visits.size).toBe(1);
 expect((await f.run({kind:'clientAction',callbackId:old})).status).toBe('stale_callback');expect(f.visits.size).toBe(1);
});
it('offer disappearance before first manual review recovers service selection preserving contact and invalidates old time',async()=>{
 const f=await manualCalendar();await f.click('6');const old=f.button('07:00'),draft=[...f.drafts.values()][0],version=draft.version;f.setEmpty();
 expect((await f.run({kind:'clientAction',callbackId:old})).status).toBe('staff_screen');expect(f.screen().text).toContain('Выберите услуги');expect(f.button('⬅️ К рабочему месту')).toBeDefined();
 expect(draft.version).toBeGreaterThan(version);expect(draft.state).toMatchObject({view:'services',services:[],name:'Ручной Клиент',phone:'+79123456101'});
 for(const key of ['start','quote','review'])expect(draft.state[key]).toBeUndefined();expect(draft.state.reviewReady).toBe(false);expect(f.visits.size).toBe(0);
 expect((await f.run({kind:'clientAction',callbackId:old})).status).toBe('stale_callback');expect(f.visits.size).toBe(0);
});
it('manual recovery never masks a permission denial after review',async()=>{
 const f=await manualCalendar();await f.click('6');await f.click('07:00');const old=f.button('Подтвердить'),draft=[...f.drafts.values()][0],version=draft.version;
 f.user('200').roles=['client'];expect((await f.run({kind:'clientAction',callbackId:old})).status).toBe('forbidden');
 expect(draft.version).toBe(version);expect(draft.state.view).toBe('manualReview');expect(f.visits.size).toBe(0);
});
