import { Bot } from 'grammy';
import type { UserFromGetMe, Update } from 'grammy/types';
import type { Env } from './env';
import { probeDatabase } from './db/probe';
import { probeTransaction } from './db/probe-transaction';
export { probeDatabase } from './db/probe';
export { ProbeScheduler } from './jobs/scheduler';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return Response.json({ ok: true });
    if (path !== '/webhook') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    // Must precede JSON parsing, bot creation, Durable Objects and external I/O.
    if (!env.WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }
    let update: Update;
    try { update = await request.json<Update>(); }
    catch { return new Response('Invalid update', { status: 400 }); }
    if (!update || !Number.isSafeInteger(update.update_id)) return new Response('Invalid update', { status: 400 });
    try {
      const bot = new Bot(env.BOT_TOKEN, {
        botInfo: JSON.parse(env.BOT_INFO) as UserFromGetMe,
        client: { timeoutSeconds: 5 },
      });
      bot.command('start', async (ctx) => {
        const result = await probeDatabase(env.DATABASE_URL);
        await ctx.reply(result.ok ? 'Тестовый бот запущен. Проверка базы прошла.' : 'База временно недоступна. Попробуйте позже.');
      });
      bot.command('probe_db', async (ctx) => {
        if (ctx.chat.type !== 'private' || String(ctx.from?.id) !== env.FIRST_ADMIN_ID) return;
        const result = await probeTransaction(env.DATABASE_URL);
        await ctx.reply(result.ok ? 'Интерактивная проверка базы прошла.' : 'Проверка базы не прошла. Попробуйте позже.');
      });
      // Temporary deployment probe: configured admin in a private chat only.
      bot.command(['probe', 'probe_status'], async (ctx) => {
        if (ctx.chat.type !== 'private' || String(ctx.from?.id) !== env.FIRST_ADMIN_ID) return;
        const scheduler = env.SCHEDULER.get(env.SCHEDULER.idFromName('deployment-probe'));
        if (ctx.msg.text.split(/\s/)[0].split('@')[0] === '/probe') {
          await scheduler.fetch('https://probe/arm', { method: 'POST' });
          await ctx.reply('Тестовый будильник назначен. Проверьте /probe_status через 5 секунд.');
        } else {
          const status = await (await scheduler.fetch('https://probe/status')).json<{ lastAlarmAt: number | null }>();
          await ctx.reply(status.lastAlarmAt ? `Будильник сработал: ${new Date(status.lastAlarmAt).toISOString()}` : 'Будильник ещё не сработал.');
        }
      });
      await bot.handleUpdate(update);
      return new Response('OK');
    } catch {
      // Provider exceptions can contain tokens, SQL and URLs. Do not log them.
      return new Response('Service unavailable', { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;
