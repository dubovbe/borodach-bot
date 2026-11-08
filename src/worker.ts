import type { Update } from 'grammy/types';
import type { Env } from './env';
import { createDatabase } from './db/client';
import { Repository } from './db/repository';
import { createBot } from './bot/create-bot';
export { probeDatabase } from './db/probe';
export { ProbeScheduler } from './jobs/scheduler';

import { CloudflareScheduler } from './jobs/scheduler';

// Count raw UTF-8 stream bytes, independently of Content-Length.
async function boundedUpdate(request: Request): Promise<Update | undefined> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid_body');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 64 * 1024) { try { await reader.cancel(); } catch { /* overlimit stays 413 */ } return undefined; }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body)) as Update;
}

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
    try {
      const parsed = await boundedUpdate(request);
      if (parsed === undefined) return new Response('Update too large', { status: 413 });
      update = parsed;
    }
    catch { return new Response('Invalid update', { status: 400 }); }
    if (!update || !Number.isSafeInteger(update.update_id)) return new Response('Invalid update', { status: 400 });
    try {
      const bot = createBot(env, new Repository(createDatabase(env.DATABASE_URL), env.FIRST_ADMIN_ID, {invitationSecret:env.INVITATION_SECRET,botUsername:JSON.parse(env.BOT_INFO).username}));
      await bot.handleUpdate(update);
      return new Response('OK');
    } catch {
      // Provider exceptions can contain tokens, SQL and URLs. Do not log them.
      return new Response('Service unavailable', { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;
