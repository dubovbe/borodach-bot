import { DomainError, type Actor, type Command, type CommandResult, type Instant } from '../domain/types';
import type { Database, Tx } from './client';
import { cleanupExpired, executeBooking, nextDue, expireJob } from '../booking/service';
export const START_TEXT = 'Тестовый бот запущен. Запись пока недоступна.';
export class Repository {
    constructor(readonly database: Database, readonly firstAdminId = '') {
    }
    async replay(updateId: string): Promise<CommandResult | null> {
        return this.database.transaction(async (tx) => this.readResult(tx, updateId));
    }
    private async readResult(tx: Tx, updateId: string): Promise<CommandResult | null> {
        const result = await tx.query<{
            result: CommandResult;
        }>('SELECT result FROM processed_updates WHERE update_id=$1', [updateId]);
        return result[0]?.result ?? null;
    }
    async execute(actor: Actor, command: Command, updateId: string): Promise<CommandResult> {
        return this.database.transaction(async (tx) => {
            const now = tx.now;
            const previous = await this.readResult(tx, updateId);
            if (previous)
                return previous;
            const userId = await this.touchUser(tx, actor, now);
            await cleanupExpired({ tx, userId, updateId });
            await tx.query('SAVEPOINT business', []);
            let result: CommandResult;
            try {
                if (command.kind !== 'start') {
                    result = await executeBooking({ tx, userId, updateId }, command);
                }
                else {
                    await tx.query('UPDATE drafts SET expires_at=$1, version=version+1 WHERE user_id=$2', [now, userId]);
                    await tx.query('INSERT INTO roles(user_id,role) VALUES($1,$2) ON CONFLICT(user_id,role) DO NOTHING', [userId, 'client']);
                    if (actor.telegramId === this.firstAdminId) {
                        await tx.query('INSERT INTO roles(user_id,role) VALUES($1,$2) ON CONFLICT(user_id,role) DO NOTHING', [userId, 'admin']);
                    }
                    result = { entityId: userId, status: 'started', nextWake: now };
                    await this.record(tx, actor, userId, updateId, now, 'start', START_TEXT);
                }
            }
            catch (error) {
                if (!(error instanceof DomainError))
                    throw error;
                await tx.query('ROLLBACK TO SAVEPOINT business', []);
                const userId = await this.touchUser(tx, actor, now);
                result = { entityId: userId, status: error.code, nextWake: now };
                // DomainError messages are controlled application copy. Provider errors never reach here.
                await this.record(tx, actor, userId, updateId, now, 'command_refused', error.message);
                if (command.kind !== 'start')
                    result.nextWake = await nextDue(tx);
            }
            await tx.query('RELEASE SAVEPOINT business', []);
            await tx.query('INSERT INTO processed_updates(update_id,actor_telegram_id,result,processed_at) VALUES($1,$2,$3::jsonb,$4)', [updateId, actor.telegramId, JSON.stringify(result), now]);
            return result;
        });
    }
    private async touchUser(tx: Tx, actor: Actor, now: Instant): Promise<string> {
        const user = await tx.query<{
            id: string;
        }>(`INSERT INTO telegram_users(telegram_id,last_seen_at) VALUES($1,$2)
      ON CONFLICT(telegram_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at,unreachable_at=NULL,version=telegram_users.version+1 RETURNING id`, [actor.telegramId, now]);
        return user[0].id;
    }
    private async record(tx: Tx, actor: Actor, userId: string, updateId: string, now: Instant, kind: string, text: string): Promise<void> {
        await tx.query('INSERT INTO audit_events(update_id,actor_id,kind,created_at) VALUES($1,$2,$3,$4)', [updateId, userId, kind, now]);
        await tx.query('INSERT INTO outbox(logical_key,update_id,kind,chat_id,payload,due_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)', [`start:${updateId}`, updateId, 'start', actor.telegramId, JSON.stringify({ text }), now]);
    }
    async nextDue(): Promise<Instant | null> {
        return this.database.read(sql => nextDue({ ...sql, now: new Date().toISOString() }));
    }
    async drainDue(_now: Instant, limit: number): Promise<{
        nextWake: Instant | null;
        remaining: boolean;
        processedCount: number;
    }> {
        let processedCount = 0;
        for (let i = 0; i < Math.max(0, Math.min(5, Math.floor(limit))); i++) {
            const processed = await this.database.transaction(async (tx) => {
                const job = (await tx.query<{
                    id: string;
                    kind: string;
                    visit_id: string | null;
                    entity_version: number;
                    payload: Record<string, unknown>;
                }>(`SELECT * FROM jobs WHERE (status='pending' AND due_at<=$1) OR (status='leased' AND COALESCE(lease_until,due_at)<=$1) ORDER BY due_at,id LIMIT 1 FOR UPDATE`, [tx.now]))[0];
                if (!job)
                    return false;
                // The shop transaction lock fences all processors; no work escapes the commit.
                const applied = await expireJob(tx, job);
                await tx.query("UPDATE jobs SET status=$2,lease_until=NULL,attempts=attempts+1,version=version+1 WHERE id=$1", [job.id, applied ? 'done' : 'cancelled']);
                return true;
            });
            if (!processed)
                break;
            processedCount++;
        }
        const nextWake = await this.nextDue();
        return { processedCount, nextWake, remaining: nextWake !== null && Date.parse(nextWake) <= Date.parse(_now) };
    }
}
