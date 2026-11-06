import type { Update } from 'grammy/types';
import type { Env } from './env';
import { createDatabase } from './db/client';
import { Repository } from './db/repository';
import { createBot } from './bot/create-bot';
export { probeDatabase } from './db/probe';
export { ProbeScheduler } from './jobs/scheduler';

import { CloudflareScheduler } from './jobs/scheduler';

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> { await new CloudflareScheduler(env.SCHEDULER).ensure(); },
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
      const bot = createBot(env, new Repository(createDatabase(env.DATABASE_URL), env.FIRST_ADMIN_ID));
      await bot.handleUpdate(update);
      return new Response('OK');
    } catch {
      // Provider exceptions can contain tokens, SQL and URLs. Do not log them.
      return new Response('Service unavailable', { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;
