import type { Instant } from '../domain/types';
import type { Repository } from '../db/repository';
export interface Scheduler { arm(nextWake: Instant | null): Promise<void> }

// Stage2 only: bound to this update, no jobs draining, leases, alarms or background tasks.
export class BootstrapScheduler implements Scheduler {
  constructor(private readonly repository: Repository, private readonly updateId: string,
    private readonly send: (chatId: string, text: string) => Promise<unknown>) {}
  async arm(_nextWake: Instant | null): Promise<void> {
    const message = await this.repository.pendingStart(this.updateId);
    if (!message) return;
    await this.send(message.chatId, message.text);
    await this.repository.markSent(message.id);
  }
}
