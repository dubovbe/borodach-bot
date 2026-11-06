import { renderInvitation, type IdentityOptions } from '../identity/service';
import { safeReplyMarkup } from '../bot/screens';
import type { Database, Tx } from '../db/client';
import { nextDue } from '../booking/service';
import type { Instant } from '../domain/types';
import { DeliveryError, type Delivery, type Transport } from './transport';
import { prepareStaffDecision } from '../bot/staff';
type Row = {
    id: string;
    kind: string;
    chat_id: string;
    payload: Record<string, unknown>;
    entity_id: string | null;
    entity_version: number | null;
    entity_type: string | null;
    claim_token: string;
    attempts: number;
    draft_id?:string|null;
    draft_version?:number|null;
};
type PreparedDelivery = {
    delivery: Delivery;
    activityVersion: number | null;
};
const validStates: Record<string, string> = {
    visit_pending: 'pending', visit_confirmed: 'confirmed', visit_declined: 'declined', visit_expired: 'expired', visit_cancelled: 'cancelled', transfer_pending: 'pending', transfer_accepted: 'accepted', transfer_declined: 'declined', transfer_expired: 'expired', transfer_cancelled: 'cancelled'
};
export class Outbox {
    constructor(private database: Database, private transport: Transport, private identityOptions: IdentityOptions = {}) {
    }
    private claim(): Promise<Row | null> {
        return this.database.transaction(async (tx) => {
            const rows = await tx.query<Row>(`UPDATE outbox SET status='leased',claim_token=gen_random_uuid(),lease_until=$1::timestamptz+interval '30 seconds',attempts=attempts+1,version=version+1 WHERE id=(SELECT id FROM outbox WHERE (status='pending' AND due_at<=$1) OR (status='leased' AND COALESCE(lease_until,due_at)<=$1) ORDER BY due_at,id LIMIT 1 FOR UPDATE) RETURNING *,chat_id::text`, [tx.now]);
            return rows[0] ?? null;
        });
    }
    private async prepare(row: Row): Promise<PreparedDelivery | null> {
        return this.database.transaction(async (tx) => {
            const owned = await tx.query<{
                id: string;
            }>("SELECT id FROM outbox WHERE id=$1 AND status='leased' AND claim_token=$2 AND lease_until>$3", [row.id, row.claim_token, tx.now]);
            if (!owned.length)
                return null;
            let text: unknown = row.payload?.text;
            let invalid: string | null = null;
            let replyMarkup: unknown;
            try { replyMarkup = safeReplyMarkup(row.payload?.reply_markup); } catch { invalid = 'invalid_payload'; }
            const user = await tx.query<{
                unreachable_at: unknown;
                version: number;
            }>('SELECT unreachable_at,version FROM telegram_users WHERE telegram_id=$1', [row.chat_id]);
            if (user[0]?.unreachable_at)
                invalid = 'unreachable';
            if (row.kind === 'booking' || row.kind === 'reminder') {
                if (!row.entity_id || !row.entity_version)
                    invalid = 'invalid_payload';
                else {
                    const transfer = row.entity_type === 'transfer';
                    const entity = (await tx.query<{
                        status: string;
                        version: number;
                    }>(transfer ? 'SELECT status,version FROM transfers WHERE id=$1' : 'SELECT status,version FROM visits WHERE id=$1', [row.entity_id]))[0];
                    const expected = row.kind === 'reminder' ? 'confirmed' : validStates[String(row.payload?.event)];
                    if (!expected)
                        invalid = 'invalid_payload';
                    else if (!entity || entity.version !== row.entity_version || entity.status !== expected)
                        invalid = 'stale_entity';
                }
                if (!invalid && row.kind === 'booking') {
                    if(typeof row.payload.staffUserId==='string'){
                        const card=await prepareStaffDecision(tx,row.entity_id!,row.payload.staffUserId,row.chat_id,row.payload.buttons);
                        if(!card)invalid='stale_entity';else {text=card.text;replyMarkup=safeReplyMarkup(card.keyboard);}
                    }else text = await bookingText(tx, row);
                }
            }
            else if (row.kind === 'invitation') {
                text = await renderInvitation(tx,row.payload.invitationId,row.chat_id,this.identityOptions);
                if (!text) invalid = 'stale_entity';
            }
            else if(row.kind==='client_screen'){
                const current=await tx.query(`SELECT d.id FROM drafts d JOIN telegram_users u ON u.id=d.user_id WHERE d.id=$1 AND d.version=$2 AND d.expires_at>$3 AND u.telegram_id=$4`,[row.draft_id??null,row.draft_version??null,tx.now,row.chat_id]);
                if(!current.length)invalid='stale_entity';
            }
            else if (!['start', 'delivery_failure'].includes(row.kind))
                invalid = 'unknown_kind';
            if (!invalid && (typeof text !== 'string' || text.length === 0 || text.length > 4096))
                invalid = 'invalid_payload';
            if (invalid) {
                await this.mark(tx, row, invalid === 'stale_entity' ? 'cancelled' : 'failed', invalid);
                return null;
            }
            return {
                delivery: {
                    id: row.id, chatId: row.chat_id, method: 'sendMessage', payload: { text, ...(replyMarkup ? {reply_markup:replyMarkup} : {}) }, entityId: row.entity_id, entityVersion: row.entity_version
                },
                activityVersion: user[0]?.version ?? null,
            };
        });
    }
    private async mark(tx: Tx, row: Row, status: string, error: string | null, messageId: string | null = null, due: Instant | null = null): Promise<boolean> {
        const result = await tx.query<{
            id: string;
        }>(`UPDATE outbox SET status=$3,last_error=$4,message_id=COALESCE($5,message_id),sent_at=CASE WHEN $3='sent' THEN $6::timestamptz ELSE sent_at END,due_at=COALESCE($7::timestamptz,due_at),lease_until=NULL,claim_token=NULL,version=version+1 WHERE id=$1 AND claim_token=$2 AND status='leased' RETURNING id`, [row.id, row.claim_token, status, error, messageId, tx.now, due]);
        return result.length === 1;
    }
    async deliver(_now: Instant, limit: number): Promise<{
        nextWake: Instant | null;
        processedCount: number;
        remaining: boolean;
    }> {
        let processedCount = 0;
        for (let i = 0; i < Math.max(0, Math.min(5, Math.floor(limit))); i++) {
            const row = await this.claim();
            if (!row)
                break;
            processedCount++;
            const prepared = await this.prepare(row);
            if (!prepared)
                continue;
            let result: {
                messageId: string;
            };
            try {
                result = await this.transport.send(prepared.delivery);
            }
            catch (error) {
                const failure = error instanceof DeliveryError ? error : new DeliveryError('transient');
                await this.database.transaction(async (tx) => {
                    const retry = ['transient', 'timeout', 'rate_limited'].includes(failure.code);
                    const seconds = failure.code === 'rate_limited' ? failure.retryAfter ?? 1 : Math.min(300, 2 ** Math.min(row.attempts, 9));
                    const owned = await this.mark(tx, row, retry ? 'pending' : 'failed', failure.code, null, retry ? new Date(Date.parse(tx.now) + seconds * 1000).toISOString() : null);
                    if (owned && failure.code === 'unreachable' && prepared.activityVersion !== null) {
                        // Inbound activity increments version. A late provider response cannot re-block
                        // a user who has since restarted or otherwise contacted the bot.
                        const updated = await tx.query<{
                            id: string;
                        }>('UPDATE telegram_users SET unreachable_at=$2 WHERE telegram_id=$1 AND version=$3 RETURNING id', [row.chat_id, tx.now, prepared.activityVersion]);
                        if (updated.length === 1 && row.kind !== 'delivery_failure')
                            await failureNotice(tx, row);
                    }
                });
                continue;
            }
            // A failed acknowledgement deliberately leaves the claim leased. Retrying the alarm cannot steal it early.
            await this.database.transaction(async (tx) => {
                await this.mark(tx, row, 'sent', null, result.messageId);
            });
        }
        return this.database.read(async (sql) => {
            const nextWake = await nextDue({ ...sql, now: _now });
            return { nextWake, processedCount, remaining: nextWake !== null && Date.parse(nextWake) <= Date.parse(_now) };
        });
    }
}
async function failureNotice(tx: Tx, row: Row): Promise<void> {
    const recipient = (await tx.query<{
        telegram_id: string;
    }>(`SELECT DISTINCT u.telegram_id::text FROM telegram_users u JOIN roles r ON r.user_id=u.id WHERE r.role IN ('admin','barber') AND u.unreachable_at IS NULL AND u.telegram_id<>$1 ORDER BY u.telegram_id::text LIMIT 1`, [row.chat_id]))[0];
    if (!recipient)
        return;
    await tx.query(`INSERT INTO outbox(logical_key,kind,chat_id,payload,due_at) VALUES($1,'delivery_failure',$2,$3::jsonb,$4) ON CONFLICT(logical_key) DO NOTHING`, [`delivery_failure:${row.id}`, recipient.telegram_id, JSON.stringify({ text: `Не удалось доставить уведомление: пользователь недоступен в Telegram. Номер уведомления: ${row.id}.` }), tx.now]);
}
async function bookingText(tx: Tx, row: Row): Promise<string | null> {
    const event = String(row.payload.event);
    const labels: Record<string, string> = {
        visit_pending: 'Заявка ожидает подтверждения.', visit_confirmed: 'Запись подтверждена.', visit_declined: 'Заявка отклонена.', visit_expired: 'Срок подтверждения заявки истёк.', visit_cancelled: 'Запись отменена.', transfer_pending: 'Запрос переноса ожидает решения.', transfer_accepted: 'Перенос принят.', transfer_declined: 'Перенос отклонён.', transfer_expired: 'Срок решения по переносу истёк.', transfer_cancelled: 'Перенос отменён.'
    };
    if (!labels[event])
        return null;
    if (event === 'visit_cancelled' && typeof row.payload.reason === 'string')
        return `Приносим извинения. Запись отменена: ${row.payload.reason}. Вы можете записаться снова.`;
    if (event !== 'visit_confirmed')
        return labels[event];
    // New events retain a snapshot at creation; legacy events can safely read immutable visit_items.
    let snapshot = row.payload.snapshot as {
        barber?: string;
        address?: string;
        start?: string;
        items?: {
            name: string;
            priceKopecks: number;
            durationMinutes: number;
        }[];
    } | undefined;
    if (!snapshot) {
        const details = (await tx.query<{
            barber: string;
            address: string;
            start_at: Date | string;
        }>(`SELECT b.name barber,s.address,v.start_at FROM visits v JOIN barbers b ON b.id=v.barber_id CROSS JOIN shop s WHERE v.id::text=$1`, [row.payload.visitId]))[0];
        if (!details)
            return null;
        const items = await tx.query<{
            name: string;
            priceKopecks: number;
            durationMinutes: number;
        }>('SELECT name,price_kopecks AS "priceKopecks",duration_minutes AS "durationMinutes" FROM visit_items WHERE visit_id::text=$1 ORDER BY id', [row.payload.visitId]);
        snapshot = { ...details, start: new Date(details.start_at).toISOString(), items };
    }
    if (typeof snapshot.barber !== 'string' || !snapshot.barber || typeof snapshot.address !== 'string' || !snapshot.address || typeof snapshot.start !== 'string' || !Number.isFinite(Date.parse(snapshot.start)) || !Array.isArray(snapshot.items) || !snapshot.items.length)
        return null;
    if (!snapshot.items.every(item => item && typeof item === 'object' && typeof item.name === 'string' && item.name.length > 0 && Number.isSafeInteger(item.priceKopecks) && item.priceKopecks >= 0 && Number.isSafeInteger(item.durationMinutes) && item.durationMinutes > 0))
        return null;
    return `${labels[event]}\nМастер: ${snapshot.barber}\nАдрес: ${snapshot.address}\n${new Date(snapshot.start).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} (МСК)\n${snapshot.items.map(i => i.name).join(', ')}\nСтоимость: ${snapshot.items.reduce((n, i) => n + i.priceKopecks, 0) / 100} ₽\nДлительность: ${snapshot.items.reduce((n, i) => n + i.durationMinutes, 0)} мин.`;
}
