import { expect,it } from 'vitest';
import * as transfers from '../../src/booking/transfers';
const call=(input:Record<string,unknown>)=>(transfers as unknown as {transferDeadline:(v:unknown)=>string|null}).transferDeadline(input);
const base={initiator:'client',now:'2026-11-06T04:00:00.000Z',oldStart:'2026-11-07T07:00:00.000Z',newStart:'2026-11-07T08:00:00.000Z',work:[{start:'2026-11-06T07:00:00.000Z',end:'2026-11-06T17:00:00.000Z'}]};
it('client waits for next work interval; staff uses continuous hour',()=>{
 expect(call(base)).toBe('2026-11-06T08:00:00.000Z');
 expect(call({...base,initiator:'staff'})).toBe('2026-11-06T05:00:00.000Z');
});
it('clips at either start and permits equality with a future start',()=>{
 expect(call({...base,oldStart:'2026-11-06T07:30:00.000Z'})).toBe('2026-11-06T07:30:00.000Z');
 expect(call({...base,newStart:'2026-11-06T07:15:00.000Z'})).toBe('2026-11-06T07:15:00.000Z');
});
it('rejects missing client work, zero or elapsed consent windows',()=>{
 expect(call({...base,work:[]})).toBeNull();
 expect(call({...base,oldStart:base.now})).toBeNull();
 expect(call({...base,newStart:'2026-11-06T03:00:00.000Z'})).toBeNull();
});
it('uses current partial shift and does not accumulate working minutes',()=>{
 expect(call({...base,now:'2026-11-06T16:50:00.000Z'})).toBe('2026-11-06T17:50:00.000Z');
});
