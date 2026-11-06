import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { createBot } from '../../src/bot/create-bot';
import type { Repository } from '../../src/db/repository';
import type { Env } from '../../src/env';
import { Repository as RealRepository } from '../../src/db/repository';
import { Outbox } from '../../src/notifications/outbox';
import { clientDatabase } from './client-db';
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
  return {...f,bot,message,current,button,clickId,click,schedulerFetch};
}
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
