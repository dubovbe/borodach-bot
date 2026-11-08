import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
test('HTTP helpers are import safe, validate config and never print provider secrets',async()=>{
 const webhook=await import('../../scripts/set-webhook.ts');const smoke=await import('../../scripts/smoke.ts');
 assert.equal(typeof webhook.setWebhook,'function');assert.equal(typeof smoke.smoke,'function');
 const old=globalThis.fetch;let calls=0;
 try{
 globalThis.fetch=async(_url,init)=>{calls++;assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');assert.deepEqual(JSON.parse(String(init?.body)),{url:'https://test.example/webhook',secret_token:'secret_test',allowed_updates:['message','callback_query'],max_connections:1,drop_pending_updates:false});return Response.json({ok:true,result:true});};
 await webhook.setWebhook({BOT_TOKEN:'123456:SENTINEL',WEBHOOK_SECRET:'secret_test',WEBHOOK_URL:'https://test.example/webhook'});
 assert.equal(calls,1);
 for(const url of ['http://test/webhook','https://x:password@test/webhook','https://test/webhook?q=1','https://test/other','https://test/webhook#x'])await assert.rejects(webhook.setWebhook({BOT_TOKEN:'123456:SENTINEL',WEBHOOK_SECRET:'secret_test',WEBHOOK_URL:url}));
 assert.equal(calls,1);
 globalThis.fetch=async()=>Response.json({ok:false,description:'SENTINEL-provider'});
 await assert.rejects(webhook.setWebhook({BOT_TOKEN:'123456:SENTINEL',WEBHOOK_SECRET:'secret_test',WEBHOOK_URL:'https://test.example/webhook'}),e=>!String(e).includes('SENTINEL'));
 }finally{globalThis.fetch=old;}
 for(const file of ['set-webhook','smoke']){
  const result=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(process.cwd()+'/scripts/'+file+'.ts').href)})`],{encoding:'utf8',timeout:5000,env:{...process.env,BOT_TOKEN:'SENTINEL',WEBHOOK_URL:'bad'}});
  assert.equal(result.status,0);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
 }
});
test('smoke sends only read-only health and deliberately invalid webhook probes',async()=>{
 const {smoke}=await import('../../scripts/smoke.ts');const calls:Array<{path:string;body:string;secret:string|undefined}>=[];
 const server=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{calls.push({path:req.url!,body,secret:req.headers['x-telegram-bot-api-secret-token'] as string|undefined});res.setHeader('content-type','application/json');if(req.url==='/health')res.end('{"ok":true}');else{res.statusCode=req.headers['x-telegram-bot-api-secret-token']==='test_secret'?400:403;res.end('{}');}});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
 const address=server.address() as {port:number};const result=await smoke({SMOKE_URL:`http://127.0.0.1:${address.port}`,WEBHOOK_SECRET:'test_secret'});
 assert.deepEqual(result,{ok:true,health:true,unauthorized:true,malformed:true});
 assert.deepEqual(calls.map(c=>c.path),['/health','/webhook','/webhook']);assert.ok(calls.slice(1).every(c=>c.body==='not-json'));
 }finally{await new Promise<void>((r,e)=>server.close(error=>error?e(error):r()));}
});
test('bounded HTTP rejects oversized bodies, redirects, extra health configuration and stalled streams',async()=>{
 const {boundedHttp}=await import('../../scripts/http-ops.ts');const {smoke}=await import('../../scripts/smoke.ts');const previous=globalThis.fetch;
 try{
  let cancelled=false;globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(16385));},cancel(){cancelled=true;}}));
  await assert.rejects(boundedHttp('https://example.test'));assert.equal(cancelled,true);
  globalThis.fetch=async()=>Response.json({ok:true,DATABASE_URL:'SENTINEL'});
  assert.equal((await smoke({SMOKE_URL:'https://example.test'})).health,false);
 }finally{globalThis.fetch=previous;}
 const server=createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{location:'/health'});res.end();}else{res.writeHead(200);res.write('{');}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;await assert.rejects(boundedHttp(base+'/redirect'));const started=Date.now();await assert.rejects(boundedHttp(base+'/stall'));assert.ok(Date.now()-started<6500);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
