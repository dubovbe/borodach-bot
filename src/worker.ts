import { Bot } from 'grammy';
import type { UserFromGetMe, Update } from 'grammy/types';
import type { Env } from './env';
import { probeDatabase } from './db/probe';
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
      await bot.handleUpdate(update);
      return new Response('OK');
    } catch {
      // Provider exceptions can contain tokens, SQL and URLs. Do not log them.
      return new Response('Service unavailable', { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;
