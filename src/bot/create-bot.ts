import { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Env } from '../env';
import type { Repository } from '../db/repository';
import { CloudflareScheduler } from '../jobs/scheduler';

export function createBot(env: Env, repository: Repository): Bot {
  const bot = new Bot(env.BOT_TOKEN, { botInfo: JSON.parse(env.BOT_INFO) as UserFromGetMe, client: { timeoutSeconds: 5 } });
  bot.command('start', async (ctx) => {
    if (!ctx.from || ctx.chat.type !== 'private') return;
    const updateId = String(ctx.update.update_id);
    const result = await repository.execute({ telegramId: String(ctx.from.id) }, { kind: 'start', payload: ctx.match || null }, updateId);
    await new CloudflareScheduler(env.SCHEDULER).arm(result.nextWake);
  });
  return bot;
}
