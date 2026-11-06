import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { createBot } from '../../src/bot/create-bot';
import type { Repository } from '../../src/db/repository';
import { CloudflareScheduler } from '../../src/jobs/scheduler';
import type { Env } from '../../src/env';
const bindings = env as unknown as Env;
afterEach(() => vi.restoreAllMocks());
const update = (type: 'private' | 'group', userId?: number) => ({ update_id: 20, message: { message_id: 1, date: 1, from: { id: 100, is_bot: false as const, first_name: 'Test' }, chat: type === 'private' ? { id: 100, type: 'private' as const, first_name: 'Test' } : { id: -1, type: 'group' as const, title: 'Group' }, contact: { phone_number: '79123456789', first_name: 'Test', ...(userId === undefined ? {} : { user_id: userId }) } } });
it('own private contact routes through execute and scheduler, never direct Telegram send', async () => {
  const execute = vi.fn().mockResolvedValue({ status: 'contact_updated', nextWake: null });
  const network = vi.spyOn(globalThis, 'fetch');
  await createBot(bindings, { execute } as unknown as Repository).handleUpdate(update('private', 100));
  expect(execute).toHaveBeenCalledWith({ telegramId: '100' }, { kind: 'updateContact', contact: { userId: '100', phone: '79123456789' } }, '20');
  expect(network).not.toHaveBeenCalled();
});
it('group contact never enters repository', async () => {
  const execute = vi.fn();
  const arm = vi.spyOn(CloudflareScheduler.prototype, 'arm');
  const http = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true, result: { message_id: 2 } }));
  await createBot(bindings, { execute } as unknown as Repository).handleUpdate(update('group', 100));
  expect(execute).not.toHaveBeenCalled();
  expect(arm).not.toHaveBeenCalled();
  expect(http).toHaveBeenCalledOnce();
  const body = JSON.parse(String(http.mock.calls[0][1]?.body));
  expect(body.text).toBe('Для записи откройте личный чат с ботом. https://t.me/test_bot');
  expect(body.text).not.toContain('79123456789');
});
it('missing user id is passed unverified to domain guard', async () => {
  const execute = vi.fn().mockResolvedValue({ status: 'invalid_contact', nextWake: null });
  await createBot(bindings, { execute } as unknown as Repository).handleUpdate(update('private'));
  expect(execute).toHaveBeenCalledWith({ telegramId: '100' }, { kind: 'updateContact', contact: { phone: '79123456789' } }, '20');
});
it('start invitation payload routes to redemption and ordinary start stays start', async () => {
  const execute = vi.fn().mockResolvedValue({ status: 'started', nextWake: null });
  for (const text of ['/start', '/start i_' + 'a'.repeat(43)]) {
    await createBot(bindings, { execute } as unknown as Repository).handleUpdate({ update_id: 21, message: { message_id: 1, date: 1, text, entities: [{ type: 'bot_command', offset: 0, length: 6 }], from: { id: 100, is_bot: false as const, first_name: 'Test' }, chat: { id: 100, type: 'private', first_name: 'Test' } } });
  }
  expect(execute.mock.calls[0][1]).toEqual({ kind: 'start', payload: null });
  expect(execute.mock.calls[1][1]).toEqual({ kind: 'start', payload: 'i_'+'a'.repeat(43) });
});
it('group guidance provider failure is best effort without business work', async () => {
  const execute = vi.fn();
  const arm = vi.spyOn(CloudflareScheduler.prototype, 'arm');
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fake-provider-failure'));
  await expect(createBot(bindings, { execute } as unknown as Repository).handleUpdate(update('group', 100))).resolves.toBeUndefined();
  expect(execute).not.toHaveBeenCalled();
  expect(arm).not.toHaveBeenCalled();
});
it('manual phone text cannot verify a contact', async () => {
  const execute = vi.fn().mockResolvedValue({status:'ignored_input',nextWake:null});
  await createBot(bindings, { execute } as unknown as Repository).handleUpdate({ update_id: 22, message: {message_id:1,date:1,text:'+79123456789',from:{id:100,is_bot:false,first_name:'Test'},chat:{id:100,type:'private',first_name:'Test'}} });
  expect(execute).toHaveBeenCalledWith({telegramId:'100'},{kind:'saveDraftInput',text:'+79123456789'},'22');
});
