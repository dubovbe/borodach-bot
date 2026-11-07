import {expect,it} from 'vitest';
import {redeliverOnceOnLockTimeout} from '../integration/redelivery';
it('a single lock failure can be redelivered to a successful acknowledgement',async()=>{
 let attempts=0;expect(await redeliverOnceOnLockTimeout(async()=>{if(++attempts===1)throw {code:'55P03'};return 'acknowledged';})).toBe('acknowledged');expect(attempts).toBe(2);
});
it('a second lock failure escapes rather than creating an unbounded retry',async()=>{
 let attempts=0;const error={code:'55P03'};await expect(redeliverOnceOnLockTimeout(async()=>{attempts++;throw error;})).rejects.toBe(error);expect(attempts).toBe(2);
});
it.each([{code:'40001'},Error('synthetic infrastructure failure')])('other failures are propagated without redelivery',async error=>{
 let attempts=0;await expect(redeliverOnceOnLockTimeout(async()=>{attempts++;throw error;})).rejects.toBe(error);expect(attempts).toBe(1);
});
