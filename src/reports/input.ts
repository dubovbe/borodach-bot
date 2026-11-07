import {DomainError} from '../domain/types';
const invalid=():never=>{throw new DomainError('invalid_input','Проверьте введённые данные.');};
export function staffReason(value:unknown):string{
 if(typeof value!=='string'||/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))return invalid();
 const text=value.trim();if(!text||text.length>500)return invalid();return text;
}
export function reportDates(from:string,to:string){
 for(const date of [from,to])if(typeof date!=='string'||!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)invalid();
 if(from>to)invalid();return {from,to};
}
export function weekDates(date:string){
 reportDates(date,date);const instant=new Date(`${date}T12:00:00Z`),day=instant.getUTCDay()||7;
 instant.setUTCDate(instant.getUTCDate()-day+1);const from=instant.toISOString().slice(0,10);
 instant.setUTCDate(instant.getUTCDate()+6);const to=instant.toISOString().slice(0,10);
 return reportDates(from,to);
}
export function safeReportNumber(value:string):number{
 if(!/^\d+$/.test(value))return invalid();const n=BigInt(value);
 if(n>BigInt(Number.MAX_SAFE_INTEGER))throw new DomainError('report_overflow','Значение отчёта слишком велико.');
 return Number(n);
}
export function formatKopecks(value:number):string{
 if(!Number.isSafeInteger(value)||value<0)return invalid();
 const amount=BigInt(value);return `${amount/100n}.${String(amount%100n).padStart(2,'0')}`;
}
export function staffMonthWindow(month:string){
 const from=`${month}-01T00:00:00+03:00`;reportDates(`${month}-01`,`${month}-01`);
 const [year,number]=month.split('-').map(Number),next=new Date(0);
 // Build the next first day at UTC midnight, then apply Moscow's explicit offset.
 next.setUTCFullYear(year,number,1);
 return {from,to:new Date(next.getTime()-3*3600000-1).toISOString()};
}
