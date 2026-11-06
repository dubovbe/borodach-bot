import type { Instant } from '../domain/types';
import type { Env } from '../env';
import { drainWake } from './drain';
export interface Scheduler {
    arm(at: Instant | null): Promise<void>;
    ensure(): Promise<void>;
}
const earliest = (...times: (number | null | undefined)[]) => {
    const finite = times.filter((t): t is number => typeof t === 'number');
    return finite.length ? Math.min(...finite) : null;
};
type WakeState = {
    nextWake: number | null;
    retryAt: number | null;
    generation: number;
};
// All durable state and alarm changes commit atomically. No SQL is used by arm/ensure.
export class WakeScheduler implements Scheduler {
    private inflight: Promise<void> | null = null;
    constructor(private storage: DurableObjectStorage, private drain: (now: Instant) => Promise<Instant | null>, private now = Date.now) {
    }
    private async load(tx: DurableObjectTransaction): Promise<WakeState> {
        return await tx.get<WakeState>('wake') ?? { nextWake: null, retryAt: null, generation: 0 };
    }
    private async save(tx: DurableObjectTransaction, s: WakeState) {
        await tx.put('wake', s);
        const at = earliest(s.nextWake, s.retryAt);
        if (at === null)
            await tx.deleteAlarm();
        else
            await tx.setAlarm(at);
    }
    async arm(at: Instant | null): Promise<void> {
        if (at === null)
            return;
        const time = Date.parse(at);
        if (!Number.isFinite(time))
            throw Error('Invalid wake time');
        await this.storage.transaction(async (tx) => {
            const s = await this.load(tx);
            if (s.nextWake === null || time < s.nextWake) {
                s.nextWake = time;
                s.generation++;
                await this.save(tx, s);
            }
        });
    }
    async ensure(): Promise<void> {
        await this.storage.transaction(async (tx) => {
            const s = await this.load(tx);
            const due = earliest(s.nextWake, s.retryAt);
            const alarm = await tx.getAlarm();
            if (due !== null && (alarm === null || alarm > due))
                await tx.setAlarm(due);
        });
    }
    alarm(): Promise<void> {
        if (this.inflight)
            return this.inflight;
        const run = this.runAlarm().finally(() => {
            this.inflight = null;
        });
        this.inflight = run;
        return run;
    }
    private async runAlarm(): Promise<void> {
        const started = this.now();
        const captured = await this.storage.transaction(async (tx) => {
            const s = await this.load(tx), due = earliest(s.nextWake, s.retryAt);
            if (due === null || due > started) {
                await this.save(tx, s);
                return null;
            }
            const generation = s.generation;
            s.nextWake = null;
            s.retryAt = started + 30000;
            await this.save(tx, s);
            return generation;
        });
        if (captured === null)
            return;
        let next: Instant | null = null, failed = false;
        try {
            next = await this.drain(new Date(started).toISOString());
        }
        catch {
            failed = true;
        }
        await this.storage.transaction(async (tx) => {
            const s = await this.load(tx);
            // New arms have their own generation and nextWake; never overwrite them with an older result.
            s.nextWake = earliest(s.nextWake, next === null ? null : Date.parse(next));
            s.retryAt = failed ? this.now() + 30000 : null;
            await this.save(tx, s);
            await tx.put('lastAlarmAt', started);
        });
    }
}
export class CloudflareScheduler implements Scheduler {
    constructor(private namespace: DurableObjectNamespace) {
    }
    private async call(path: string, body: unknown): Promise<void> {
        const stub = this.namespace.get(this.namespace.idFromName('shop'));
        const response = await stub.fetch(`https://scheduler${path}`, { method: 'POST', body: JSON.stringify(body) });
        if (!response.ok)
            throw Error('Scheduler unavailable');
    }
    arm(nextWake: Instant | null) {
        return nextWake === null ? Promise.resolve() : this.call('/arm', { nextWake });
    }
    ensure() {
        return this.call('/ensure', {});
    }
}
// Preserve deployed class/binding and the v1-probe migration history.
export class ProbeScheduler {
    private wake: WakeScheduler;
    constructor(private state: DurableObjectState, env: Env) {
        this.wake = new WakeScheduler(state.storage, now => drainWake(env, now));
    }
    async fetch(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (request.method === 'GET' && path === '/status')
            return Response.json({ nextAlarm: await this.state.storage.getAlarm(), wake: await this.state.storage.get('wake') ?? null, lastAlarmAt: await this.state.storage.get('lastAlarmAt') ?? null });
        if (request.method === 'POST' && path === '/ensure') {
            await this.wake.ensure();
            return Response.json({ ok: true });
        }
        if (request.method === 'POST' && path === '/arm') {
            let data: {
                nextWake?: unknown;
            };
            try {
                data = await request.json();
            }
            catch {
                return new Response('Invalid wake', { status: 400 });
            }
            if (data.nextWake !== null && (typeof data.nextWake !== 'string' || !Number.isFinite(Date.parse(data.nextWake))))
                return new Response('Invalid wake', { status: 400 });
            await this.wake.arm(data.nextWake as Instant | null);
            return Response.json({ ok: true });
        }
        return new Response('Not found', { status: 404 });
    }
    alarm() {
        return this.wake.alarm();
    }
}
