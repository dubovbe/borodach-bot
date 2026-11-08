import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@neondatabase/serverless';
import worker from '../../src/worker';
import type { Env } from '../../src/env';
const bindings=env as unknown as Env;
afterEach(()=>vi.restoreAllMocks());
const request=(body:BodyInit,headers:Record<string,string>={})=>new Request('https://test/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':bindings.WEBHOOK_SECRET,...headers},body});
it.each([{}, {'Content-Length':'1'}] as Record<string,string>[])('authorized stream byte cap rejects oversized body before any I/O %j',async headers=>{
 const connect=vi.spyOn(Client.prototype,'connect').mockRejectedValue(Error('unreachable'));
 const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('unreachable'));
 const response=await worker.fetch(request(JSON.stringify({update_id:1,padding:'я'.repeat(32768)}),headers),bindings,createExecutionContext());
 expect(response.status).toBe(413);expect(connect).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
it('exact 64 KiB valid JSON reaches normal validation while plus one is rejected',async()=>{
 const prefix='{"padding":"',suffix='"}';const exact=prefix+'x'.repeat(65536-prefix.length-suffix.length)+suffix;
 expect((await worker.fetch(request(exact),bindings,createExecutionContext())).status).toBe(400);
 expect((await worker.fetch(request(exact+' '),bindings,createExecutionContext())).status).toBe(413);
});
it('forbidden body is never read and authorized overlimit reader is cancelled',async()=>{
 let reads=0,cancelled=false;
 const stream=()=>new ReadableStream<Uint8Array>({pull(c){reads++;if(reads===1)c.enqueue(new Uint8Array(65537));else c.close();},cancel(){cancelled=true;}},{highWaterMark:0});
 const forbidden=await worker.fetch(request(stream(),{'X-Telegram-Bot-Api-Secret-Token':'wrong'}),bindings,createExecutionContext());
 expect(forbidden.status).toBe(403);expect(reads).toBe(0);
 expect((await worker.fetch(request(stream()),bindings,createExecutionContext())).status).toBe(413);expect(cancelled).toBe(true);
});


it('small malformed/null UTF-8 is 400 and exact-limit supported JSON is allowed without I/O',async()=>{
 const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('unexpected'));
 const connect=vi.spyOn(Client.prototype,'connect').mockRejectedValue(Error('unexpected'));
 for(const body of ['null','{',new Uint8Array([255])])expect((await worker.fetch(request(body),bindings,createExecutionContext())).status).toBe(400);
 const prefix='{"update_id":112233,"padding":"',suffix='"}',body=prefix+'x'.repeat(65536-prefix.length-suffix.length)+suffix;
 expect((await worker.fetch(request(body),bindings,createExecutionContext())).status).toBe(200);expect(fetch).not.toHaveBeenCalled();expect(connect).not.toHaveBeenCalled();
});
