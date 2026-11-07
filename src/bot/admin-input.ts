import {DomainError} from '../domain/types';
import {isMeaningfulName} from '../identity/service';
const invalid=():never=>{throw new DomainError('invalid_input','Проверьте введённое значение.');};
const integer=(text:string,min:number,max=2147483647)=>{const value=text.trim();if(!/^\d+$/.test(value)||value.length>16)invalid();const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)invalid();return n;};
export function parseRoubles(text:string):number{const value=text.trim();if(!/^\d+(?:[.,]\d{1,2})?$/.test(value)||value.length>20)invalid();const [whole,fraction='']=value.split(/[.,]/);const n=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));if(n>2147483647n)invalid();return Number(n);}
export const parseMinutes=(text:string)=>integer(text,1);
export const parseHorizon=(text:string)=>integer(text,1,365);
export function parseName(text:string):string{if(!isMeaningfulName(text))invalid();return text.trim();}
export function parseDate(text:string):string{if(!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(text)||!Number.isFinite(Date.parse(text))||new Date(text).toISOString().slice(0,10)!==text)invalid();return text;}
export function parseIntervals(text:string):{startMinute:number;endMinute:number}[]{
 let last=-1;
 return text.split(',').map(part=>{const m=/^\s*(\d{2}):(\d{2})\s*[-–—]\s*(\d{2}):(\d{2})\s*$/.exec(part);if(!m)return invalid();const [sh,sm,eh,em]=m.slice(1).map(Number),startMinute=sh*60+sm,endMinute=eh*60+em;if(sh>23||sm>59||eh>24||em>59||(eh===24&&em!==0)||startMinute>=endMinute||startMinute<last)invalid();last=endMinute;return {startMinute,endMinute};});
}
