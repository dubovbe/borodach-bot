import { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Env } from '../env';
import type { Repository } from '../db/repository';
import { CloudflareScheduler } from '../jobs/scheduler';

export function createBot(env: Env, repository: Repository): Bot {
  const botInfo = JSON.parse(env.BOT_INFO) as UserFromGetMe;
  const bot = new Bot(env.BOT_TOKEN, { botInfo, client: { timeoutSeconds: 5 } });
  const groupGuidance = async (reply: (text:string)=>Promise<unknown>) => {
    // Generic navigation only: no database, scheduler, contact echoes or durable mutation.
    try { await reply(`Для записи откройте личный чат с ботом. https://t.me/${botInfo.username}`); } catch { /* best effort */ }
  };
  bot.command('start', async (ctx) => {
    if (!ctx.from) return;
    if (ctx.chat.type !== 'private') { await groupGuidance(text=>ctx.reply(text)); return; }
    const payload = ctx.match || null;
    const command = payload?.startsWith('i_') ? { kind:'redeemInvite' as const, token:payload.slice(2) } : { kind:'start' as const, payload };
    const result = await repository.execute({ telegramId: String(ctx.from.id) }, command, String(ctx.update.update_id));
    await new CloudflareScheduler(env.SCHEDULER).arm(result.nextWake);
  });
  bot.on('message:contact', async ctx => {
    if (!ctx.from) return;
    if (ctx.chat.type !== 'private') { await groupGuidance(text=>ctx.reply(text)); return; }
    const contact = ctx.message.contact;
    const result = await repository.execute({telegramId:String(ctx.from.id)}, {kind:'updateContact', contact:{phone:contact.phone_number,...(contact.user_id===undefined?{}:{userId:String(contact.user_id)})}},String(ctx.update.update_id));
    await new CloudflareScheduler(env.SCHEDULER).arm(result.nextWake);
  });
  return bot;
}
