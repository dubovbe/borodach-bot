import { safeReplyMarkup } from '../bot/screens';
export type Delivery = {
    id: string;
    chatId: string;
    method: string;
    payload: unknown;
    entityId: string | null;
    entityVersion: number | null;
};
export type ErrorCode = 'transient' | 'timeout' | 'rate_limited' | 'unreachable' | 'permanent' | 'invalid_payload';
export class DeliveryError extends Error {
    constructor(readonly code: ErrorCode, readonly retryAfter?: number) {
        super(code);
        this.name = 'DeliveryError';
    }
}
export interface Transport {
    send(job: Delivery): Promise<{
        messageId: string;
    }>;
}
export class TelegramTransport implements Transport {
    constructor(private token: string) {
    }
    async send(job: Delivery): Promise<{
        messageId: string;
    }> {
        if (job.method !== 'sendMessage' || !job.payload || typeof job.payload !== 'object' || typeof (job.payload as {
            text?: unknown;
        }).text !== 'string')
            throw new DeliveryError('invalid_payload');
        let replyMarkup: unknown;
        try { replyMarkup = safeReplyMarkup((job.payload as {reply_markup?:unknown}).reply_markup); } catch { throw new DeliveryError('invalid_payload'); }
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                (async () => {
                    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: (job.payload as {
                                text: string;
                            }).text, chat_id: job.chatId, ...(replyMarkup ? {reply_markup:replyMarkup} : {}) }), signal: controller.signal
                    });
                    const data = await response.json() as {
                        ok?: boolean;
                        error_code?: number;
                        parameters?: {
                            retry_after?: number;
                        };
                        result?: {
                            message_id?: number;
                        };
                    };
                    if (data.ok && data.result?.message_id !== undefined)
                        return { messageId: String(data.result.message_id) };
                    const code = data.error_code ?? response.status;
                    if (code === 429)
                        throw new DeliveryError('rate_limited', Math.max(1, Number(data.parameters?.retry_after) || 1));
                    if (code === 403)
                        throw new DeliveryError('unreachable');
                    throw new DeliveryError(code >= 500 ? 'transient' : 'permanent');
                })(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        controller.abort();
                        reject(new DeliveryError('timeout'));
                    }, 5000);
                }),
            ]);
            return result;
        }
        catch (error) {
            throw error instanceof DeliveryError ? error : new DeliveryError('transient');
        }
        finally {
            clearTimeout(timer);
        }
    }
}
