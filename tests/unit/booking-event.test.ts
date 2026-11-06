import type { Tx } from '../../src/db/client';
import { event } from '../../src/booking/service';
import { expect,it,vi } from 'vitest';
it('booking_event_snapshot_and_recipients_commit_in_one_sql_roundtrip',async()=>{
 const query=vi.fn(async()=>[{version:2,start_at:'2026-11-06T00:00:00.000Z',telegram_id:'100'}]);
 await event({tx:{now:'2026-11-06T00:00:00.000Z',query} as Tx,userId:null,updateId:null},'visit_expired','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001');
 expect(query).toHaveBeenCalledOnce();
});
