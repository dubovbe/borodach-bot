export class ProbeScheduler {
  private readonly state: DurableObjectState;
  constructor(state: DurableObjectState) { this.state = state; }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === '/arm') {
      await this.state.storage.setAlarm(Date.now() + 5000);
      return Response.json({ ok: true });
    }
    if (request.method === 'GET' && path === '/status') {
      return Response.json({ nextAlarm: await this.state.storage.getAlarm(),
        lastAlarmAt: (await this.state.storage.get<number>('lastAlarmAt')) ?? null });
    }
    return new Response('Not found', { status: 404 });
  }
  async alarm(): Promise<void> {
    // Technical timestamp only; no customer data, no database polling, no next alarm.
    await this.state.storage.put('lastAlarmAt', Date.now());
  }
}
