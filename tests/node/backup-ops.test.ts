import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,copyFileSync,chmodSync,unlinkSync,existsSync,rmdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const root=process.cwd();
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'stage11-ops-')),bin=join(dir,'native tools'),output=join(dir,'bundles');mkdirSync(bin);mkdirSync(output);
 const migrations=readdirSync('src/db/schema').filter(n=>/\.sql$/.test(n)).sort().map(name=>({name,checksum:createHash('sha256').update(readFileSync(join('src/db/schema',name))).digest('hex')}));
 writeFileSync(join(bin,'migrations.json'),JSON.stringify(migrations));
 if(process.platform==='win32'){
  const csc=join(process.env.WINDIR??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const compile=spawnSync(csc,['/nologo','/target:exe','/out:'+join(bin,'pg_dump.exe'),resolve('tests/node/fake-pg.cs')],{encoding:'utf8',timeout:15000});
  assert.equal(compile.status,0,'native fake utility compilation required: '+compile.stdout);for(const name of ['psql','pg_restore'])copyFileSync(join(bin,'pg_dump.exe'),join(bin,name+'.exe'));
 }else{
  const source=`#!/usr/bin/env node
const fs=require('node:fs'),p=require('node:path');const dir=p.dirname(process.argv[1]),name=p.basename(process.argv[1]),args=process.argv.slice(2),flag=n=>fs.existsSync(p.join(dir,n));
if(process.env.PGPASSWORD!=='SENTINEL password')process.exit(2);fs.writeFileSync(p.join(dir,'tls.txt'),(process.env.PGSSLMODE??'')+'|'+(process.env.PGSSLROOTCERT??''));
let record=name+':'+args.join('|')+'\\n';for(const k of ['PGOPTIONS','PGSERVICE','PGSERVICEFILE','PGPASSFILE','PGHOSTADDR','BOT_TOKEN','INVITATION_SECRET','WEBHOOK_SECRET','DATABASE_URL','NODE_OPTIONS'])if(process.env[k]!==undefined)record+='LEAK:'+k+'\\n';fs.appendFileSync(p.join(dir,'calls.txt'),record);
if(args[0]==='--version'){console.log(name+' (PostgreSQL) '+(flag('old')?'17.9':'18.6'));process.exit(0);}
if(name==='psql'){const q=args.at(-1);console.log(q.includes('server_version_num')?JSON.stringify({database:process.env.PGDATABASE,version:180006}):q.includes('schema_migrations')?fs.readFileSync(p.join(dir,'migrations.json'),'utf8'):q.includes('pg_depend')?(flag('cross')?'1':'0'):(flag('nonempty')?'1':'0'));process.exit(0);}
if(name==='pg_dump'){fs.writeFileSync(args[args.indexOf('--file')+1],flag('empty')?'':'PGDMP-synthetic-archive');if(flag('slow'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);if(flag('fail')){console.error('SENTINEL-provider-password');process.exit(1);}process.exit(0);}
if(args.includes('--list')){console.log('; Dumped from database version: 18.6\\n; Dumped by pg_dump version: 18.6\\n'+(flag('badlist')?'1; 1 1 TABLE other secret owner':'1; 2615 1 SCHEMA - public owner\\n2; 1259 2 TABLE public settings owner\\n3; 0 2 TABLE DATA public settings owner'));process.exit(0);}
if(flag('restorefail')){console.error('SENTINEL-provider-password');process.exit(1);}fs.writeFileSync(p.join(dir,'restored.txt'),args.join('|'));`;
  for(const name of ['psql','pg_dump','pg_restore']){writeFileSync(join(bin,name),source);chmodSync(join(bin,name),0o755);}
 }
 const env={...process.env,BACKUP_DATABASE_URL:'postgresql://synthetic:SENTINEL%20password@localhost/stage11_fixture_'+'a'.repeat(32)+'?sslmode=disable',RESTORE_DATABASE_URL:'postgresql://synthetic:SENTINEL%20password@localhost/stage11_restore_'+'b'.repeat(32)+'?sslmode=disable',BACKUP_SCHEMA:'public',BACKUP_DIR:output,PG_BIN_DIR:bin,SYNTHETIC_TEST:'true',PGSSLROOTCERT:'SENTINEL-inherited-root',INVITATION_SECRET:'SENTINEL',WEBHOOK_SECRET:'SENTINEL',PGHOSTADDR:'SENTINEL',PGOPTIONS:'SENTINEL',PGSERVICE:'SENTINEL',PGPASSFILE:'SENTINEL',BOT_TOKEN:'SENTINEL',DATABASE_URL:'SENTINEL',NODE_BIN:process.execPath};
 const run=(mode='backup',changes:Record<string,string|undefined>={})=>spawnSync(process.execPath,['scripts/backup-ops.ts',mode],{env:{...env,...changes},encoding:'utf8',timeout:15000});
 return {dir,bin,output,env,run,flag:(name:string)=>writeFileSync(join(bin,name),'yes'),remove:(name:string)=>unlinkSync(join(bin,name)),cleanup:()=>{for(const directory of [bin,output]){for(const name of readdirSync(directory))unlinkSync(join(directory,name));rmdirSync(directory);}rmdirSync(dir);}};
}
function result(run:ReturnType<typeof spawnSync>,ok:boolean,code='BACKUP_FAILED'){
 assert.equal(run.error,undefined);assert.equal(run.status,ok?0:1);assert.equal(run.stderr,'');assert.doesNotMatch(String(run.stdout),/SENTINEL/);const parsed=JSON.parse(String(run.stdout));assert.equal(parsed.ok,ok);if(!ok)assert.equal(parsed.code,code);
}
test('real CLI subprocess scope, credentials, successful bundles, retention and failure age',()=>{
 const f=fixture();try{
 writeFileSync(join(f.output,'unrelated.dump'),'untouched');
 for(let n=0;n<8;n++)result(f.run(),true);
 const manifests=readdirSync(f.output).filter(n=>n.endsWith('.json'));assert.equal(manifests.length,7);assert.equal(readFileSync(join(f.output,'unrelated.dump'),'utf8'),'untouched');
 const before=manifests.map(n=>readFileSync(join(f.output,n),'utf8'));
 const status=JSON.parse(String(f.run('status').stdout));assert.equal(status.available,true);assert.equal(typeof status.ageSeconds,'number');
 f.flag('fail');result(f.run(),false);assert.deepEqual(readdirSync(f.output).filter(n=>n.endsWith('.json')).map(n=>readFileSync(join(f.output,n),'utf8')),before);f.remove('fail');
 f.flag('empty');result(f.run(),false);f.remove('empty');f.flag('badlist');result(f.run(),false);f.remove('badlist');f.flag('cross');result(f.run(),false);f.remove('cross');
 const calls=readFileSync(join(f.bin,'calls.txt'),'utf8');assert.doesNotMatch(calls,/SENTINEL|LEAK:|postgresql:\/\//);assert.match(calls,/--schema=public/);assert.match(calls,/--format=custom/);
 const manifest=JSON.parse(before[0]);assert.equal(manifest.migrations.length,6);assert.ok(manifest.migrationSources?.every((m:any)=>createHash('sha256').update(Buffer.from(m.base64,'base64')).digest('hex')===m.checksum));
 }finally{f.cleanup();}
});
test('restore refuses equivalent, nonempty, mismatched version and altered archives before native restore',()=>{
 const f=fixture();try{
 result(f.run(),true);const archive=join(f.output,readdirSync(f.output).find(n=>n.endsWith('.dump'))!);const config={RESTORE_ARCHIVE:archive};
 result(f.run('restore',{...config,RESTORE_DATABASE_URL:f.env.BACKUP_DATABASE_URL.replace('synthetic:','different:')}),false,'RESTORE_FAILED');
 f.flag('nonempty');result(f.run('restore',config),false,'RESTORE_FAILED');f.remove('nonempty');
 f.flag('old');result(f.run('restore',config),false,'RESTORE_FAILED');f.remove('old');assert.equal(existsSync(join(f.bin,'restored.txt')),false);
 writeFileSync(archive,'altered');result(f.run('restore',config),false,'RESTORE_FAILED');assert.equal(existsSync(join(f.bin,'restored.txt')),false);
 }finally{f.cleanup();}
});
test('offline restore uses transactional flags and PowerShell entry preserves sanitized failure',()=>{
 const f=fixture();try{
 result(f.run(),true);const archive=join(f.output,readdirSync(f.output).find(n=>n.endsWith('.dump'))!);result(f.run('restore',{RESTORE_ARCHIVE:archive}),true);
 const args=readFileSync(join(f.bin,'restored.txt'),'utf8');for(const flag of ['--single-transaction','--exit-on-error','--no-owner','--no-acl'])assert.ok(args.includes(flag));assert.doesNotMatch(args,/--clean|--create|SENTINEL/);
 const wrapped=spawnSync('pwsh',['-NoProfile','-NonInteractive','-File','scripts/backup.ps1'],{env:{...f.env,BACKUP_DATABASE_URL:'SENTINEL-invalid'},encoding:'utf8',timeout:15000});result(wrapped,false);
 }finally{f.cleanup();}
});
test('overlapping real subprocess backups serialize and do not prune on losing attempt',async()=>{
 const f=fixture();f.flag('slow');try{
 const child=()=>new Promise<{status:number|null;stdout:string;stderr:string}>((r,e)=>{const p=spawn(process.execPath,['scripts/backup-ops.ts','backup'],{env:f.env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',c=>stdout+=c);p.stderr.on('data',c=>stderr+=c);p.on('error',e);p.on('close',status=>r({status,stdout,stderr}));});
 const outcomes=await Promise.all([child(),child()]);assert.deepEqual(outcomes.map(r=>r.status).sort(),[0,1]);assert.equal(readdirSync(f.output).filter(n=>n.endsWith('.dump')).length,1);assert.ok(outcomes.every(r=>r.stderr===''&&!r.stdout.includes('SENTINEL')));
 }finally{f.cleanup();}
});
test('connection parser is strict, normalizes secure TLS, and never inherits runtime fallback',async()=>{
 const {connection,utility}=await import('../../scripts/backup-ops.ts');
 const c=connection('postgresql://u%40x:p%20word@example.com/db?sslmode=require&channel_binding=require');
 assert.equal(c.user,'u@x');assert.equal(c.password,'p word');assert.equal(c.sslmode,'verify-full');assert.equal(c.channelBinding,'require');
 assert.equal(connection('postgresql://a:b@LOCALHOST:5432/db?sslmode=disable').identity,connection('postgresql://other:password@localhost/db?sslmode=disable').identity);
 for(const value of [undefined,'https://u:p@host/db','postgresql://u@host/db','postgresql://u:p@host/','postgresql://u:p@host/a/b','postgresql://u:p@host/db#secret','postgresql://u:p@host/db?options=-cfoo','postgresql://u:p@host/db?sslmode=disable','postgresql://u:p@host/db?channel_binding=bad','postgresql://u:p@ep-x-pooler.neon.tech/db','postgresql://u:p@host/db?sslmode=require&sslmode=verify-full'])assert.throws(()=>connection(value));
 const started=Date.now();await assert.rejects(utility(process.execPath,['-e','process.stderr.write("SENTINEL"); setInterval(()=>{},1000)'],{},80),e=>String(e)==='Error: OPS_FAILED');assert.ok(Date.now()-started<2000);
});
test('explicit CA path is validated and schema, path, migration-source and failed-restore guards fail closed',()=>{
 const f=fixture();try{
 for(const changes of [{BACKUP_SCHEMA:'public*'},{BACKUP_SCHEMA:'pg_catalog'},{BACKUP_DIR:'relative'},{SYNTHETIC_TEST:'true',BACKUP_DATABASE_URL:'postgresql://x:y@localhost/application?sslmode=disable'},{PG_SSL_ROOT_CERT:join(f.bin,'missing-SENTINEL.pem')}])result(f.run('backup',changes),false);
 writeFileSync(join(f.bin,'root.pem'),'SENTINEL-not-pem');result(f.run('backup',{PG_SSL_ROOT_CERT:join(f.bin,'root.pem')}),false);
 const migrations=join(f.bin,'migrations.json'),original=readFileSync(migrations,'utf8');writeFileSync(migrations,JSON.stringify([{name:'001-core.sql',checksum:'a'.repeat(64)}]));result(f.run(),false);writeFileSync(migrations,original);
 result(f.run(),true);const archive=join(f.output,readdirSync(f.output).find(n=>n.endsWith('.dump'))!);f.flag('restorefail');result(f.run('restore',{RESTORE_ARCHIVE:archive}),false,'RESTORE_FAILED');assert.equal(existsSync(join(f.bin,'restored.txt')),false);
 }finally{f.cleanup();}
});



test('explicit public root CA reaches only the intended native libpq environment with verify-full',async()=>{
 const {rootCertificates}=await import('node:tls');const f=fixture();try{
 const ca=join(f.bin,'root.pem');writeFileSync(ca,rootCertificates[0]);
 const source=f.env.BACKUP_DATABASE_URL.replace('@localhost/','@ep-synthetic.neon.tech/').replace('sslmode=disable','sslmode=require');
 result(f.run('backup',{BACKUP_DATABASE_URL:source,PG_SSL_ROOT_CERT:ca}),true);assert.equal(readFileSync(join(f.bin,'tls.txt'),'utf8'),'verify-full|'+ca);
 assert.doesNotMatch(readFileSync(join(f.bin,'calls.txt'),'utf8'),/SENTINEL|LEAK:/);
 }finally{f.cleanup();}
});

async function waitFor(predicate:()=>boolean,limit=5000){const end=Date.now()+limit;while(!predicate()){assert.ok(Date.now()<end,'bounded owner-start wait');await new Promise(r=>setTimeout(r,25));}}
test('crashed operation owner releases scope while a live owner remains exclusive',async()=>{
 const f=fixture();f.flag('slow');let owner:ReturnType<typeof spawn>|undefined;
 try{
  owner=spawn(process.execPath,['scripts/backup-ops.ts','backup'],{env:f.env,stdio:['ignore','pipe','pipe']});let stderr='';owner.stderr!.on('data',c=>stderr+=c);
  await waitFor(()=>existsSync(join(f.bin,'calls.txt'))&&readFileSync(join(f.bin,'calls.txt'),'utf8').includes('--format=custom'));
  result(f.run(),false);assert.equal(readdirSync(f.output).filter(n=>n.endsWith('.dump.json')).length,0);
  const stopped=new Promise<void>((r,e)=>{owner!.once('close',()=>r());owner!.once('error',e);});owner.kill('SIGKILL');await stopped;owner=undefined;assert.equal(stderr,'');
  f.remove('slow');result(f.run(),true);assert.equal(readdirSync(f.output).filter(n=>n.endsWith('.dump.json')).length,1);
 }finally{owner?.kill('SIGKILL');f.cleanup();}
});
test('valid trusted recovery bundle restores with unavailable source credentials',()=>{
 const f=fixture();try{
  result(f.run(),true);const archive=join(f.output,readdirSync(f.output).find(n=>n.endsWith('.dump'))!);
  const unavailable=f.env.BACKUP_DATABASE_URL.replace('synthetic:SENTINEL%20password@','lost:SENTINEL-invalid@');
  result(f.run('backup',{BACKUP_DATABASE_URL:unavailable}),false);
  result(f.run('restore',{BACKUP_DATABASE_URL:unavailable,RESTORE_ARCHIVE:archive}),true);
  assert.ok(existsSync(join(f.bin,'restored.txt')));
 }finally{f.cleanup();}
});
test('encoded conninfo database names are refused before any credential-bearing native process',()=>{
 const f=fixture();try{
  result(f.run(),true);const archive=join(f.output,readdirSync(f.output).find(n=>n.endsWith('.dump'))!),before=readFileSync(join(f.bin,'calls.txt'),'utf8');
  const shaped='postgresql://synthetic:SENTINEL%20password@localhost/host%3Dother.example%20dbname%3Dx?sslmode=disable';
  result(f.run('restore',{SYNTHETIC_TEST:'false',RESTORE_DATABASE_URL:shaped,RESTORE_ARCHIVE:archive}),false,'RESTORE_FAILED');
  assert.equal(readFileSync(join(f.bin,'calls.txt'),'utf8'),before);assert.equal(existsSync(join(f.bin,'restored.txt')),false);
  result(f.run('backup',{SYNTHETIC_TEST:'false',BACKUP_DATABASE_URL:shaped}),false);assert.equal(readFileSync(join(f.bin,'calls.txt'),'utf8'),before);
 }finally{f.cleanup();}
});
test('published backup with failed pruning retains valid age and alerts Node and PowerShell with exit 2',async()=>{
 const {pathToFileURL}=await import('node:url');const f=fixture();try{
  for(let n=0;n<7;n++)result(f.run(),true);
  // Inject only an OS unlink permission failure, retaining real native child processes,
  // filesystem publication, manifest validation, hashing, CLI and PowerShell execution.
  const replacement=`export * from 'node:fs/promises';import {unlink as original} from 'node:fs/promises';export async function unlink(path){if(String(path).endsWith('.dump'))throw Error('SENTINEL-EACCES');return original(path);}`;
  const preload=join(f.bin,'prune-denied.mjs');writeFileSync(preload,`import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(specifier==='node:fs/promises'&&context.parentURL?.endsWith('/scripts/backup-ops.ts'))return {url:${JSON.stringify('data:text/javascript,'+encodeURIComponent(replacement))},shortCircuit:true};return next(specifier,context);}});`);
  const env={...f.env,NODE_OPTIONS:'--import='+pathToFileURL(preload).href};
  for(const [executable,args] of [[process.execPath,['scripts/backup-ops.ts','backup']],['pwsh',['-NoProfile','-NonInteractive','-File','scripts/backup.ps1']]] as const){
   const run=spawnSync(executable,args,{env,encoding:'utf8',timeout:15000});assert.equal(run.error,undefined);assert.equal(run.status,2);assert.equal(run.stderr,'');assert.deepEqual(JSON.parse(run.stdout),{ok:true,backup:true,retention:false});assert.doesNotMatch(run.stdout,/SENTINEL/);
  }
  const library=spawnSync(process.execPath,['--input-type=module','-e',`const m=await import(${JSON.stringify(pathToFileURL(resolve('scripts/backup-ops.ts')).href)});const backup=await m.backup(process.env);console.log(JSON.stringify({backup,status:await m.backupStatus(process.env)}));`],{env,encoding:'utf8',timeout:15000});
  assert.equal(library.status,0);assert.equal(library.stderr,'');const parsed=JSON.parse(library.stdout);assert.equal(parsed.backup.backup,true);assert.equal(parsed.backup.retention,false);assert.equal(parsed.status.available,true);assert.equal(typeof parsed.status.ageSeconds,'number');assert.ok(readdirSync(f.output).filter(n=>n.endsWith('.dump.json')).length>=8);
 }finally{f.cleanup();}
});
