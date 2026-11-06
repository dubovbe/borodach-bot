import { expireJob } from '../../src/booking/service';
import { expect,it,vi } from 'vitest';
it('malformed_transfer_job_json_null_terminates_without_retry',async()=>{
 const query=vi.fn(async()=>[]);
 expect(await expireJob({now:'2026-11-06T00:00:00.000Z',query},{kind:'expire_transfer',visit_id:null,entity_version:1,payload:null as unknown as Record<string,unknown>})).toBe(false);
 expect(query).not.toHaveBeenCalled();
});
