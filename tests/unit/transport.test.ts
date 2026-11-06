import { afterEach, expect, it, vi } from 'vitest';
import { TelegramTransport, DeliveryError } from '../../src/notifications/transport';
afterEach(() => vi.restoreAllMocks());
const job = { id: 'a', chatId: '100', method: 'sendMessage', payload: { text: 'hello' }, entityId: null, entityVersion: null };
it('telegram_429_uses_retry_after', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: false, error_code: 429, parameters: { retry_after: 900 } }));
    await expect(new TelegramTransport('test').send(job)).rejects.toMatchObject({ code: 'rate_limited', retryAfter: 900 });
});
it('telegram_errors_are_sanitized', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('token-secret'));
    await expect(new TelegramTransport('test').send(job)).rejects.toEqual(new DeliveryError('transient'));
});
it('telegram_403_is_permanent_unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: false, error_code: 403 }));
    await expect(new TelegramTransport('test').send(job)).rejects.toMatchObject({ code: 'unreachable' });
});

it('telegram_send_times_out_and_aborts_after_five_seconds', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        signal = init?.signal;
        return new Promise(() => {});
    });
    try {
        const result = expect(new TelegramTransport('test').send(job)).rejects.toMatchObject({code:'timeout'});
        await vi.advanceTimersByTimeAsync(5000);
        await result;
        expect(signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
});
it('telegram_400_is_permanent', async () => {
    vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({ok:false,error_code:400}));
    await expect(new TelegramTransport('test').send(job)).rejects.toMatchObject({code:'permanent'});
});

it('contact keyboard passes server-controlled markup, rejects arbitrary keyboard instructions', async () => {
    const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({ok:true,result:{message_id:1}}));
    const reply_markup={keyboard:[[{text:'Поделиться телефоном',request_contact:true}]],resize_keyboard:true,one_time_keyboard:true};
    await new TelegramTransport('test').send({...job,payload:{text:'Phone',reply_markup}});
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).reply_markup).toEqual(reply_markup);
    await expect(new TelegramTransport('test').send({...job,payload:{text:'Phone',reply_markup:{inline_keyboard:[[{text:'bad',url:'https://bad.invalid'}]]}}})).rejects.toMatchObject({code:'invalid_payload'});
});
