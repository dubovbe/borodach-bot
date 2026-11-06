import type { Env } from '../env';
import type { Instant } from '../domain/types';
import { createDatabase } from '../db/client';
import { Repository } from '../db/repository';
import { Outbox } from '../notifications/outbox';
import { TelegramTransport } from '../notifications/transport';
export async function drainBatch(repository: Pick<Repository, 'drainDue' | 'nextDue'>, outbox: Pick<Outbox, 'deliver'>, now: Instant): Promise<Instant | null> {
    const jobs = await repository.drainDue(now, 5);
    const messages = await outbox.deliver(now, 5 - jobs.processedCount);
    const next = await repository.nextDue();
    return jobs.remaining || messages.remaining || (next !== null && Date.parse(next) <= Date.now()) ? new Date(Date.now() + 1000).toISOString() : next;
}
export async function drainWake(env: Env, now: Instant): Promise<Instant | null> {
    const database = createDatabase(env.DATABASE_URL);
    return drainBatch(new Repository(database), new Outbox(database, new TelegramTransport(env.BOT_TOKEN), {invitationSecret:env.INVITATION_SECRET,botUsername:JSON.parse(env.BOT_INFO).username}), now);
}
