import { DomainError, type Id, type Instant } from '../domain/types';
export type ReminderHours=1|2|3|4|5;
export type ReminderPlan={key:string;dueAt:Instant;kind:'day'|'near'};
export function validateReminderHours(hours:number):asserts hours is ReminderHours {
  if(!Number.isInteger(hours)||hours<1||hours>5)throw new DomainError('invalid_reminder_hours','Выберите напоминание за 1–5 часов.');
}
// Legacy visits without confirmation evidence use only the remaining future cutoff.
// They do not acquire a fabricated historical confirmation timestamp.
export function remainingReminders(input:{visitId:Id;version:number;start:Instant;now:Instant;hours:ReminderHours;confirmedAt?:Instant}):ReminderPlan[]{
  validateReminderHours(input.hours);
  const start=Date.parse(input.start),cutoff=Math.max(Date.parse(input.now),input.confirmedAt===undefined?-Infinity:Date.parse(input.confirmedAt));
  if(!Number.isFinite(start)||!Number.isFinite(cutoff)||!Number.isInteger(input.version)||input.version<1)throw new DomainError('invalid_reminder_plan','Некорректное время записи.');
  const plans:ReminderPlan[]=[];
  const add=(kind:'day'|'near',due:number)=>{if(due>cutoff)plans.push({key:`reminder:${input.visitId}:${input.version}:${kind}`,kind,dueAt:new Date(due).toISOString()});};
  add('day',start-86400000);
  const wanted=start-input.hours*3600000;
  add('near',wanted>cutoff?wanted:start-3600000);
  return plans;
}
export function planReminders(input:{visitId:Id;version:number;start:Instant;confirmedAt:Instant;now:Instant;hours:ReminderHours}):ReminderPlan[]{return remainingReminders(input);}
