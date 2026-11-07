import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { createBot } from '../../src/bot/create-bot';
import type { Repository } from '../../src/db/repository';
import type { Env } from '../../src/env';
import { Repository as RealRepository } from '../../src/db/repository';
import { Outbox } from '../../src/notifications/outbox';
import { clientDatabase } from './client-db';
import { Client } from '@neondatabase/serverless';
import { createExecutionContext } from 'cloudflare:test';
import worker from '../../src/worker';
afterEach(()=>vi.restoreAllMocks());
it('private opaque callback enters protected client controller, then best effort ACK', async()=>{
  const execute=vi.fn().mockResolvedValue({status:'screen',nextWake:null});
  const http=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('synthetic failure'));
  const callbackId=crypto.randomUUID();
  await expect(createBot(env as unknown as Env,{execute} as unknown as Repository).handleUpdate({update_id:600,callback_query:{id:'ack',chat_instance:'private',from:{id:100,is_bot:false,first_name:'Test'},data:callbackId,message:{message_id:1,date:1,chat:{id:100,type:'private',first_name:'Test'},text:'Screen'}}})).resolves.toBeUndefined();
  expect(execute).toHaveBeenCalledWith({telegramId:'100'},{kind:'clientAction',callbackId},'600');
  expect(http).toHaveBeenCalledOnce();
});
it('private name text routes to draft input; group callback never mutates', async()=>{
  const execute=vi.fn().mockResolvedValue({status:'screen',nextWake:null});
  const bot=createBot(env as unknown as Env,{execute} as unknown as Repository);
  await bot.handleUpdate({update_id:601,message:{message_id:1,date:1,text:'Test Client',from:{id:100,is_bot:false,first_name:'Test'},chat:{id:100,type:'private',first_name:'Test'}}});
  expect(execute).toHaveBeenCalledWith({telegramId:'100'},{kind:'saveDraftInput',text:'Test Client'},'601');
});

async function flow(){
  const schedulerFetch=vi.fn().mockResolvedValue(Response.json({ok:true}));
  const bindings={...env,SCHEDULER:{idFromName:()=>({}),get:()=>({fetch:schedulerFetch})}} as unknown as Env;
  const f=clientDatabase(),bot=createBot(bindings,new RealRepository(f.database));
  vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({ok:true,result:true}));
  let update=700;
  const message=async(text:string)=>bot.handleUpdate({update_id:update++,message:{message_id:1,date:1,text,...(text.startsWith('/start')?{entities:[{type:'bot_command' as const,offset:0,length:6}]}:{}),from:{id:100,is_bot:false,first_name:'Test'},chat:{id:100,type:'private',first_name:'Test'}}});
  const current=()=>f.outbox.find(o=>o.kind==='client_screen'&&o.status==='pending')?.payload;
  const button=(label:string)=>{const s=current();const b=s?.reply_markup.inline_keyboard.flat().find((b:any)=>/^\d+$/.test(label)?b.text===label:b.text.includes(label));expect(b,JSON.stringify(s)).toBeTruthy();return b.callback_data;};
  const clickId=async(id:string,actor=100,updateId=update++)=>bot.handleUpdate({update_id:updateId,callback_query:{id:'ack',chat_instance:'private',from:{id:actor,is_bot:false,first_name:'Test'},data:id,message:{message_id:1,date:1,chat:{id:actor,type:'private',first_name:'Test'},text:'Screen'}}});
  const click=async(label:string)=>clickId(button(label));
  return {...f,bot,message,current,button,clickId,click,schedulerFetch,bindings};
}
it('management entry is reachable before profile and settings phone Back returns to settings',async()=>{
  const f=await flow();await f.message('/start');await f.click('Настройки');
  expect(f.current().text).toContain('Напоминание');await f.click('Телефон');
  expect(f.current().reply_markup.keyboard[0][0].request_contact).toBe(true);
  await f.message('Назад');expect(f.current().text).toContain('Напоминание');
  expect(f.visits.size).toBe(0);
});
it('real routing keeps preference before first request and permits two-step pending withdrawal after submit',async()=>{
  const f=await flow();await f.message('/start');await f.click('Настройки');await f.click('5 ч.');expect(f.user('100').reminder_hours).toBe(5);
  await f.click('К записи');await f.click('Вымышленный мастер');await f.click('Тестовая стрижка');await f.click('Далее');await f.click('6');await f.click('10:00');await f.message('Тест');
  await f.bot.handleUpdate({update_id:1700,message:{message_id:1,date:1,contact:{phone_number:'79123456789',user_id:100,first_name:'Test'},from:{id:100,is_bot:false,first_name:'Test'},chat:{id:100,type:'private',first_name:'Test'}}});
  await f.click('Отправить');expect(f.current().text).toContain('Заявка отправлена');await f.click('Мои записи');expect(f.current().text).toContain('Ожидает решения');
  await f.click('Отозвать');expect([...f.visits.values()][0].status).toBe('pending');const affirmative=f.button('Да, отменить');await f.clickId(affirmative);expect([...f.visits.values()][0].status).toBe('cancelled');await f.clickId(affirmative);expect([...f.visits.values()][0].version).toBe(2);
});
it('settings contact resumes without booking slot or name; verified text phone never substitutes contact',async()=>{
 const f=await flow();await f.message('/start');await f.click('Настройки');await f.click('Телефон');await f.message('+79123456789');expect(f.user('100').verified).toBe(false);
 await f.bot.handleUpdate({update_id:1800,message:{message_id:1,date:1,contact:{phone_number:'79123456789',user_id:100,first_name:'Test'},from:{id:100,is_bot:false,first_name:'Test'},chat:{id:100,type:'private',first_name:'Test'}}});
 expect(f.current().text).toContain('Напоминание');expect(f.current().text).toContain('+79123456789');expect(f.visits.size).toBe(0);expect(f.user('100').name).toBe('');
});
it('returning from settings into incomplete booking resumes required onboarding before Submit',async()=>{
 const f=await flow();await f.message('/start');await f.click('Вымышленный мастер');await f.click('Тестовая стрижка');await f.click('Далее');await f.click('6');await f.click('10:00');expect(f.current().text).toContain('Введите');
 await f.click('Настройки');await f.click('К записи');expect(f.current().text).toContain('Введите');
 await f.message('Тест');expect(f.current().reply_markup.keyboard[0][0].request_contact).toBe(true);expect(f.visits.size).toBe(0);
});
it('stale own confirmation refreshes own list without cancelling the newer visit version',async()=>{
 const f=await flow(),u=f.user('100');await f.message('/start');const v={id:crypto.randomUUID(),client_id:u.client,barber_id:'00000000-0000-4000-8000-000000000002',status:'confirmed',start_at:'2026-11-07T18:00:00.000Z',end_at:'2026-11-07T18:45:00.000Z',version:1,items:[]};f.visits.set(v.id,v);
 await f.click('Мои записи');await f.click('Отменить');const yes=f.button('Да, отменить');v.version=2;await f.clickId(yes);expect(v.status).toBe('confirmed');expect(v.version).toBe(2);expect(f.current().text).toContain('Список обновлён');
});
it('real settings commit survives failed scheduler arm and same update replay changes the draft once',async()=>{
 const f=await flow();await f.message('/start');await f.click('Настройки');const cb=f.button('5 ч.');f.schedulerFetch.mockRejectedValueOnce(Error('synthetic arm failure'));
 await expect(f.clickId(cb,100,1900)).rejects.toThrow('synthetic arm failure');expect(f.user('100').reminder_hours).toBe(5);const version=[...f.drafts.values()][0].version;
 await f.clickId(cb,100,1900);expect([...f.drafts.values()][0].version).toBe(version);expect(f.user('100').reminder_hours).toBe(5);
});
it('real webhook returns 503 on precommit lock failure and exact-update redelivery submits once with usable management',async()=>{
 const f=await flow();f.user('100').name='Тест';f.user('100').verified=true;
 await f.message('/start');await f.click('Вымышленный мастер');await f.click('Тестовая стрижка');await f.click('Далее');await f.click('6');await f.click('10:00');
 const submit=f.button('Отправить'),oldScreen=f.outbox.find(o=>o.kind==='client_screen'&&o.status==='pending'),oldVersion=[...f.drafts.values()][0].version;
 Object.assign(oldScreen,{status:'leased',claim_token:'previous-claim',lease_until:'2026-11-06T04:00:30.000Z'});
 let failLock=true;
 vi.spyOn(Client.prototype,'connect').mockResolvedValue();vi.spyOn(Client.prototype,'end').mockResolvedValue();
 vi.spyOn(Client.prototype,'query').mockImplementation((async(text:string,values:unknown[]=[])=>{
  if(text.startsWith('SELECT id FROM shop')){if(failLock){failLock=false;throw Object.assign(Error('synthetic lock timeout'),{code:'55P03'});}return {rows:[{id:1}]};}
  if(text.startsWith('SELECT clock_timestamp'))return {rows:[{now:new Date(f.now)}]};
  if(text==='BEGIN'||text==='COMMIT'||text==='ROLLBACK'||text.startsWith('SET LOCAL'))return {rows:[]};
  return {rows:await f.database.read(sql=>sql.query(text,values))};
 }) as never);
 const update={update_id:99001,callback_query:{id:'ack',chat_instance:'private',from:{id:100,is_bot:false,first_name:'Test'},data:submit,message:{message_id:1,date:1,chat:{id:100,type:'private',first_name:'Test'},text:'Screen'}}};
 const request=()=>new Request('https://test/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':f.bindings.WEBHOOK_SECRET},body:JSON.stringify(update)});
 expect((await worker.fetch(request(),f.bindings,createExecutionContext())).status).toBe(503);expect(f.visits.size).toBe(0);expect([...f.drafts.values()][0].version).toBe(oldVersion);expect(oldScreen.claim_token).toBe('previous-claim');
 expect((await worker.fetch(request(),f.bindings,createExecutionContext())).status).toBe(200);expect(f.visits.size).toBe(1);expect([...f.drafts.values()][0].version).toBe(oldVersion+1);expect(oldScreen.status).toBe('cancelled');expect(oldScreen.claim_token).toBeNull();
 const management=f.button('Мои записи');expect((await worker.fetch(request(),f.bindings,createExecutionContext())).status).toBe(200);expect(f.visits.size).toBe(1);expect([...f.drafts.values()][0].version).toBe(oldVersion+1);
 const delivered:any[]=[];await new Outbox(f.database,{send:async d=>{delivered.push(d);return {messageId:'submitted'};}}).deliver(f.now,5);expect(delivered.some(d=>d.payload.reply_markup?.inline_keyboard.flat().some((b:any)=>b.text==='Мои записи'))).toBe(true);
 await f.clickId(management);expect(f.current().text).toContain('Ожидает решения');
});
it('large own-bookings page remains deliverable and preserves all five cancellation buttons',async()=>{
 const f=await flow(),u=f.user('100');await f.message('/start');
 for(let n=0;n<5;n++){
  const id=crypto.randomUUID(),day=String(7+n).padStart(2,'0');
  f.visits.set(id,{id,client_id:u.client,barber_id:'00000000-0000-4000-8000-000000000002',status:'confirmed',start_at:`2026-11-${day}T10:00:00.000Z`,end_at:`2026-11-${day}T12:00:00.000Z`,version:1,items:Array.from({length:12},(_,i)=>({name:`Услуга ${i+1}: ${'Длинное название '.repeat(5)}`.slice(0,80),priceKopecks:10000,durationMinutes:10}))});
 }
 await f.click('Мои записи');expect(f.current().reply_markup.inline_keyboard.flat().filter((b:any)=>b.text.startsWith('Отменить'))).toHaveLength(5);
 const deliveries:any[]=[];await new Outbox(f.database,{send:async d=>{deliveries.push(d);return {messageId:'large-page'};}}).deliver(f.now,5);
 const delivered=deliveries.find(d=>d.chatId==='100'&&d.payload.reply_markup?.inline_keyboard.flat().filter((b:any)=>b.text.startsWith('Отменить')).length===5);
 expect(delivered,'the bookings page must survive the real Outbox delivery validation').toBeTruthy();
 expect(delivered.payload.text.length).toBeLessThanOrEqual(4096);expect(delivered.payload.text.match(/Мастер:/g)).toHaveLength(5);expect(delivered.payload.text.match(/Подтверждена/g)).toHaveLength(5);expect(delivered.payload.text.match(/МСК/g)).toHaveLength(5);expect([...f.visits.values()].every(v=>v.items.length===12&&v.items.every((i:any)=>i.name.length===80))).toBe(true);
});
it('real routing/controller: start, checked multi-services, calendar, time, name/contact, pending, barber confirms exact client details',async()=>{
  const f=await flow();
  await f.message('/start');await f.click('Вымышленный мастер');await f.click('Тестовая стрижка');await f.click('Тестовая борода');
  expect(f.current().reply_markup.inline_keyboard.flat().filter((b:any)=>b.text.startsWith('☑'))).toHaveLength(2);
  await f.click('Далее');await f.click('6');await f.click('10:00');
  expect(f.visits.size).toBe(0);expect(f.current().text).toContain('Введите');
  await f.message('Тестовый Клиент');expect(f.current().reply_markup.keyboard[0][0].request_contact).toBe(true);
  await f.bot.handleUpdate({update_id:799,message:{message_id:1,date:1,contact:{phone_number:'79123456789',user_id:100,first_name:'Test'},from:{id:100,is_bot:false,first_name:'Test'},chat:{id:100,type:'private',first_name:'Test'}}});
  expect(f.current().text).toContain('3000 ₽');expect(f.current().text).toContain('90 мин.');
  const submit=f.button('Отправить');await f.clickId(submit);await f.clickId(submit);expect(f.visits.size).toBe(1);
  expect(f.schedulerFetch).toHaveBeenCalled();
  await f.message('/start');
  const deliveries:any[]=[];const outbox=new Outbox(f.database,{send:async d=>{deliveries.push(d);return {messageId:'1'};}});
  await outbox.deliver(f.now,5);
  const staff=deliveries.find(d=>d.chatId==='200');expect(staff.payload.text).toContain('Тестовый Клиент');expect(staff.payload.text).toContain('+79123456789');
  const confirm=staff.payload.reply_markup.inline_keyboard[0][0].callback_data;
  await f.clickId(confirm,200);await outbox.deliver(f.now,5);
  const final=deliveries.find(d=>d.chatId==='100'&&d.payload.text.startsWith('Запись подтверждена'));
  expect(final.payload.text).toContain('Вымышленная улица, 1');expect(final.payload.text).toContain('Тестовая борода');expect(final.payload.text).toContain('3000 ₽');
});
it('foreign, stale and repeated update cannot select entities; quote changes force review',async()=>{
  const f=await flow();f.user('100').name='Тест';f.user('100').verified=true;
  await f.message('/start');const old=f.button('Вымышленный мастер');
  await f.clickId(old,101);expect([...f.drafts.values()][0].barber_id).toBeNull();
  await f.clickId(old,100,901);const version=[...f.drafts.values()][0].version;await f.clickId(old,100,901);expect([...f.drafts.values()][0].version).toBe(version);
  await f.click('Тестовая стрижка');await f.click('Далее');await f.click('6');await f.click('10:00');const submit=f.button('Отправить');
  f.setPrice(150100);await f.clickId(submit);expect(f.visits.size).toBe(0);expect(f.current().text).toContain('Условия изменились');
  await f.message('/start');await f.clickId(submit);expect(f.current().text).toContain('Кнопка устарела');expect([...f.drafts.values()][0].barber_id).toBeNull();
});
it('empty catalog and unavailable month explain next action; unsolicited text never changes profile',async()=>{
  const f=await flow();f.setEmpty();await f.message('/start');expect(f.current().text).toContain('нет доступных мастеров');await f.message('Не имя');expect(f.user('100').name).toBe('');
  const g=await flow();g.setNoWork();await g.message('/start');await g.click('Вымышленный мастер');await g.click('Тестовая стрижка');await g.click('Далее');expect(g.current().text).toContain('Нет доступных дней');
});
it('name controls and foreign contact never complete profile; Back and disabled dates never reserve',async()=>{
  const f=await flow();await f.message('/start');await f.click('Вымышленный мастер');await f.click('Тестовая стрижка');await f.click('Далее');
  const disabled=f.current().reply_markup.inline_keyboard.flat().find((b:any)=>b.text.startsWith('·'));
  expect(f.callbacks.get(disabled.callback_data).action.kind).toBe('noop');await f.clickId(disabled.callback_data);expect(f.visits.size).toBe(0);
  await f.click('6');await f.click('10:00');await f.message('Bad\nName');expect(f.current().text).toContain('одной строкой');expect(f.user('100').name).toBe('');
  await f.message('Тест');
  await f.bot.handleUpdate({update_id:899,message:{message_id:1,date:1,contact:{phone_number:'79123456789',user_id:101,first_name:'Other'},from:{id:100,is_bot:false,first_name:'Test'},chat:{id:100,type:'private',first_name:'Test'}}});
  expect(f.user('100').verified).toBe(false);expect(f.visits.size).toBe(0);
  await f.message('Назад');expect(f.current().text).toContain('Выберите время');
});
it.each([['onboarding',true],['onboarding',false],['stale-refresh',true],['stale-refresh',false]] as const)('reviewed summary %s records displayed price; changed back: %s',async(path,reverts)=>{
  const f=await flow();f.setPrice(160000);
  if(path==='stale-refresh'){f.user('100').name='Тест';f.user('100').verified=true;}
  await f.message('/start');await f.click('Вымышленный мастер');await f.click('Тестовая стрижка');await f.click('Далее');await f.click('6');const time=f.button('10:00');await f.clickId(time);
  const oldSubmit=path==='stale-refresh'?f.button('Отправить'):null;
  f.setPrice(150000);
  if(path==='onboarding'){
    await f.message('Тест');await f.bot.handleUpdate({update_id:9500,message:{message_id:1,date:1,contact:{phone_number:'79123456789',user_id:100,first_name:'Test'},from:{id:100,is_bot:false,first_name:'Test'},chat:{id:100,type:'private',first_name:'Test'}}});
  }else await f.clickId(time);
  expect(f.current().text).toContain('1500 ₽');const submit=f.button('Отправить'),d=[...f.drafts.values()][0];
  expect(JSON.parse(d.state.quote).items[0].priceKopecks).toBe(150000);expect(f.callbacks.get(submit).draft_version).toBe(d.version);
  if(oldSubmit)expect(f.callbacks.get(oldSubmit).draft_version).toBeLessThan(d.version);
  if(reverts)f.setPrice(160000);await f.clickId(submit);
  if(reverts){expect(f.visits.size).toBe(0);expect(f.current().text).toContain('Условия изменились');}
  else {expect(f.visits.size).toBe(1);expect([...f.visits.values()][0].items[0].priceKopecks).toBe(150000);}
});
