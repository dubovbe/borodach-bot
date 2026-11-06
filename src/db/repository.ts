import { DomainError, type Actor, type Command, type CommandResult, type Instant } from '../domain/types';
import type { Database, Tx } from './client';
import { cleanupExpired, executeBooking, nextDue } from '../booking/service';

export const START_TEXT = 'Тестовый бот запущен. Запись пока недоступна.';
export class Repository {
  constructor(readonly database: Database, readonly firstAdminId = '') {}

  async replay(updateId: string): Promise<CommandResult | null> {
    return this.database.transaction(async (tx) => this.readResult(tx, updateId));
  }

  private async readResult(tx: Tx, updateId: string): Promise<CommandResult | null> {
    const result = await tx.query<{ result: CommandResult }>('SELECT result FROM processed_updates WHERE update_id=$1', [updateId]);
    return result[0]?.result ?? null;
  }

  async execute(actor: Actor, command: Command, updateId: string): Promise<CommandResult> {
    return this.database.transaction(async (tx) => {
      const now = tx.now;
      const previous = await this.readResult(tx, updateId);
      if (previous) return previous;
      const userId = await this.touchUser(tx, actor, now);
      await cleanupExpired({tx,userId,updateId});
      await tx.query('SAVEPOINT business', []);
      let result: CommandResult;
      try {
        if (command.kind !== 'start') {
          result = await executeBooking({tx,userId,updateId},command);
        } else {
          await tx.query('UPDATE drafts SET expires_at=$1, version=version+1 WHERE user_id=$2', [now,userId]);
          await tx.query('INSERT INTO roles(user_id,role) VALUES($1,$2) ON CONFLICT(user_id,role) DO NOTHING', [userId,'client']);
          if (actor.telegramId === this.firstAdminId) {
            await tx.query('INSERT INTO roles(user_id,role) VALUES($1,$2) ON CONFLICT(user_id,role) DO NOTHING', [userId,'admin']);
          }
          result = { entityId: userId, status: 'started', nextWake: now };
          await this.record(tx, actor, userId, updateId, now, 'start', START_TEXT);
        }
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        await tx.query('ROLLBACK TO SAVEPOINT business', []);
        const userId = await this.touchUser(tx, actor, now);
        result = { entityId: userId, status: error.code, nextWake: now };
        // DomainError messages are controlled application copy. Provider errors never reach here.
        await this.record(tx, actor, userId, updateId, now, 'command_refused', error.message);
        if(command.kind!=='start') result.nextWake=await nextDue(tx);
      }
      await tx.query('RELEASE SAVEPOINT business', []);
      await tx.query('INSERT INTO processed_updates(update_id,actor_telegram_id,result,processed_at) VALUES($1,$2,$3::jsonb,$4)',
        [updateId,actor.telegramId,JSON.stringify(result),now]);
      return result;
    });
  }

  private async touchUser(tx: Tx, actor: Actor, now: Instant): Promise<string> {
    const user = await tx.query<{ id: string }>(`INSERT INTO telegram_users(telegram_id,last_seen_at) VALUES($1,$2)
      ON CONFLICT(telegram_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at,version=telegram_users.version+1 RETURNING id`, [actor.telegramId,now]);
    return user[0].id;
  }

  private async record(tx: Tx, actor: Actor, userId: string, updateId: string, now: Instant, kind: string, text: string): Promise<void> {
    await tx.query('INSERT INTO audit_events(update_id,actor_id,kind,created_at) VALUES($1,$2,$3,$4)', [updateId,userId,kind,now]);
    await tx.query('INSERT INTO outbox(logical_key,update_id,kind,chat_id,payload,due_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)',
      [`start:${updateId}`,updateId,'start',actor.telegramId,JSON.stringify({ text }),now]);
  }

  async pendingStart(updateId: string): Promise<{ id: string; chatId: string; text: string } | null> {
    return this.database.read(async (client) => {
      const rows = await client.query<{ id: string; chat_id: string; payload: { text: string } }>(
        'SELECT id,chat_id,payload FROM outbox WHERE update_id=$1 AND kind=$2 AND sent_at IS NULL', [updateId,'start']);
      const row = rows[0];
      return row ? { id: row.id, chatId: row.chat_id, text: row.payload.text } : null;
    });
  }

  async markSent(outboxId: string): Promise<void> {
    await this.database.read(async (client) => {
      const result = await client.query('UPDATE outbox SET sent_at=clock_timestamp() WHERE id=$1 AND kind=$2 RETURNING id', [outboxId,'start']);
      if (result.length !== 1) throw new Error('Outbox message is missing');
    });
  }
}
