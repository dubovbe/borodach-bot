export type Id = string;
export type Instant = string;
export type Interval = { start: Instant; end: Instant };
export type Actor = { telegramId: Id };
export class DomainError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'DomainError'; }
}
export type IdentityCommand = { kind:'updateContact'; contact:{userId?:Id;phone:string} }
 | {kind:'issueBarberInvite';barberId:Id}
 | {kind:'revokeInvite';invitationId:Id}
 | {kind:'redeemInvite';token:string};
export type ClientCommand = {kind:'clientAction';callbackId:Id} | {kind:'saveDraftInput';text:string};
export type TransferCommand = {kind:'requestTransfer';visitId:Id;expectedVersion:number;newStart:Instant;reason?:string}
 | {kind:'proposeTransfer';visitId:Id;expectedVersion:number;newStart:Instant;reason?:string}
 | {kind:'decideTransfer';transferId:Id;expectedVersion:number;accept:boolean}
 | {kind:'recordPhoneAgreement';transferId:Id;expectedVersion:number};
export type Command = TransferCommand | IdentityCommand | ClientCommand | { kind: 'start'; payload: string | null }
 | { kind:'requestBooking'; barberId:Id; serviceIds:Id[]; start:Instant }
 | { kind:'confirmBooking'|'declineBooking'|'cancelBooking'; visitId:Id; expectedVersion:number; reason?:string;purpose?:'client' }
 | {kind:'setReminderHours';hours:number}
 | {kind:'withdrawBooking';visitId:Id;expectedVersion:number;purpose?:'client'}
 | { kind:'changeSchedule'; barberId:Id; expectedVersion:number; schedule:WorkSchedule };
export type CommandResult = { entityId?: Id; status: string; nextWake: Instant | null };
export type OfferItem = { serviceId: Id; name: string; priceKopecks: number; durationMinutes: number };
export type Conflict = Interval & { visitId: Id; kind: 'visit' | 'transfer' };
export type WorkSchedule = { timezone: 'Europe/Moscow'; weekly: Record<number, { startMinute: number; endMinute: number }[]>;
  exceptions: Record<string, { startMinute: number; endMinute: number }[]> };
export type Draft = { id: Id; telegramId: Id; version: number; barberId: Id | null; lockedBarber: boolean;
  serviceIds: Id[]; selectedStart: Instant | null; expiresAt: Instant };
