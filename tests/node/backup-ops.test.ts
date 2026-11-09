import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,copyFileSync,chmodSync,unlinkSync,existsSync,rmdirSync,realpathSync,symlinkSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {realpath} from 'node:fs/promises';
const root=process.cwd();
function fixture(base=tmpdir()){
 const original=mkdtempSync(join(base,'stage11-ops-')),dir=realpathSync.native(original),bin=join(dir,'native tools'),output=join(dir,'bundles');mkdirSync(bin);mkdirSync(output);
 const normalized=(path:string)=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
 const originalTempCanonical=normalized(original)===normalized(dir);
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
 const run=(mode='backup',changes:Record<string,string|undefined>={})=>{
  const outcome=spawnSync(process.execPath,['scripts/backup-ops.ts',mode],{env:{...env,...changes},encoding:'utf8',timeout:15000});
  const calls=existsSync(join(bin,'calls.txt'))?readFileSync(join(bin,'calls.txt'),'utf8'):'';
  return Object.assign(outcome,{diagnostic:{originalTempCanonical,nativePhase:calls.includes('--list')?'list':calls.includes('--format=custom')?'dump':calls.includes('--command')?'preflight':calls.includes('--version')?'version':'not-started'}});
 };
 return {dir,bin,output,env,run,originalTempCanonical,flag:(name:string)=>writeFileSync(join(bin,name),'yes'),remove:(name:string)=>unlinkSync(join(bin,name)),cleanup:()=>{for(const directory of [bin,output]){for(const name of readdirSync(directory))unlinkSync(join(directory,name));rmdirSync(directory);}rmdirSync(dir);}};
}
function result(run:ReturnType<typeof spawnSync>,ok:boolean,code='BACKUP_FAILED'){
 assert.equal(run.error,undefined);assert.equal(run.status,ok?0:1,JSON.stringify((run as typeof run&{diagnostic?:unknown}).diagnostic));assert.equal(run.stderr,'');assert.doesNotMatch(String(run.stdout),/SENTINEL/);const parsed=JSON.parse(String(run.stdout));assert.equal(parsed.ok,ok);if(!ok)assert.equal(parsed.code,code);
}
function boundaryDiagnostic(f:ReturnType<typeof fixture>){
 const script=String.raw`
 import {lstatSync,realpathSync} from 'node:fs';
 import {realpath as promisedRealpath} from 'node:fs/promises';
 import {dirname,parse,resolve,join} from 'node:path';
 import {spawnSync} from 'node:child_process';
 import {backup,connection} from ${JSON.stringify(new URL('../../scripts/backup-ops.ts',import.meta.url).href)};
 import {operationLock} from ${JSON.stringify(new URL('../../scripts/operation-lock.ts',import.meta.url).href)};
 const frames=error=>String(error?.stack??'').split('\n').flatMap(line=>{
  const file=line.match(/(backup-ops|operation-lock)\.ts:(\d+):\d+/);if(!file)return [];
  const fn=line.match(/\bat (?:async )?([A-Za-z_$][\w$]*)/),allowed=['fail','connection','canonicalDirectory','checkedFile','configuration','tools','operationLock','versions','inspect','scoped','utility','backup'];
  return [{file:file[1],phase:fn&&allowed.includes(fn[1])?fn[1]:'callback',line:Number(file[2])}];
 }).slice(0,6);
 const normalize=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
 const diagnostic={directoryCheck:false,canonicalEqual:false,canonicalEqualAsync:false,ancestorReparse:false,ipcAcquired:false,ipcReleased:false,libraryBackup:false,failureFrames:[],nativeStatus:null,nativeError:'none',nativeVersionValid:false};
 try{diagnostic.canonicalEqual=normalize(process.env.BACKUP_DIR)===normalize(realpathSync(process.env.BACKUP_DIR));diagnostic.canonicalEqualAsync=normalize(process.env.BACKUP_DIR)===normalize(await promisedRealpath(process.env.BACKUP_DIR));
  for(let p=resolve(process.env.BACKUP_DIR);;p=dirname(p)){if(lstatSync(p).isSymbolicLink())diagnostic.ancestorReparse=true;if(p===parse(p).root)break;}diagnostic.directoryCheck=true;
 }catch{}
 try{const scope='stage11-'+connection(process.env.BACKUP_DATABASE_URL).identity+'-public-operation';const release=await operationLock(process.env.BACKUP_DIR,scope);diagnostic.ipcAcquired=true;await release();diagnostic.ipcReleased=true;}catch{}
 try{await backup(process.env);diagnostic.libraryBackup=true;}catch(error){diagnostic.failureFrames=frames(error);}
 const nativeEnv={};for(const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL'])if(process.env[key])nativeEnv[key]=process.env[key];
 Object.assign(nativeEnv,{PGHOST:'localhost',PGPORT:'5432',PGDATABASE:'stage11_fixture_'+'a'.repeat(32),PGUSER:'synthetic',PGPASSWORD:'SENTINEL password',PGSSLMODE:'disable',PGCHANNELBINDING:'prefer',PGCONNECT_TIMEOUT:'5',PGAPPNAME:'stage11-offline-ops'});
 const native=spawnSync(join(process.env.PG_BIN_DIR,'pg_dump'+(process.platform==='win32'?'.exe':'')),['--version'],{env:nativeEnv,shell:false,windowsHide:true,encoding:'utf8',timeout:5000});
 diagnostic.nativeStatus=native.status;diagnostic.nativeError=native.error?['ENOENT','EACCES','EPERM','ETIMEDOUT','EINVAL'].includes(native.error.code)?native.error.code:'OTHER':'none';diagnostic.nativeVersionValid=/^pg_dump \(PostgreSQL\) 18\.6\s*$/.test(native.stdout??'');
 console.log(JSON.stringify(diagnostic));`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{env:f.env,encoding:'utf8',timeout:20000});
 // Never forward a diagnostic subprocess stack, environment, paths or provider output.
 if(child.status!==0||child.stderr)return {diagnosticProcess:false};
 try{return JSON.parse(child.stdout);}catch{return {diagnosticProcess:false};}
}
test('real CLI subprocess scope, credentials, successful bundles, retention and failure age',async t=>{
 const f=fixture();try{
 writeFileSync(join(f.output,'unrelated.dump'),'untouched');
 const asyncCanonical=await realpath(f.output),nativeSyncCanonical=realpathSync.native(f.output);
 for(let n=0;n<8;n++){const outcome=f.run();if(n===0){t.diagnostic(JSON.stringify({...outcome.diagnostic,asyncCanonicalEqual:asyncCanonical===f.output,nativeAsyncEqual:asyncCanonical===nativeSyncCanonical}));if(outcome.status!==0)t.diagnostic(JSON.stringify(boundaryDiagnostic(f)));}result(outcome,true);}
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

test('synthetic fixture canonicalizes temp aliases while production still refuses a supplied junction',()=>{
 const directory=realpathSync.native(mkdtempSync(join(tmpdir(),'s11-'))),physical=join(directory,'p'),alias=join(directory,'a');mkdirSync(physical);symlinkSync(physical,alias,process.platform==='win32'?'junction':'dir');
 let f:ReturnType<typeof fixture>|undefined;
 try{
  f=fixture(alias);result(f.run(),true);
  const aliasedOutput=join(alias,relative(physical,f.output));assert.equal(realpathSync.native(aliasedOutput),f.output);const before=readFileSync(join(f.bin,'calls.txt'),'utf8');
  result(f.run('backup',{BACKUP_DIR:aliasedOutput}),false);assert.equal(readFileSync(join(f.bin,'calls.txt'),'utf8'),before);
  f.env.BACKUP_DIR=aliasedOutput;const diagnostic=boundaryDiagnostic(f);assert.equal(diagnostic.ancestorReparse,true);assert.equal(diagnostic.libraryBackup,false);assert.ok(diagnostic.failureFrames.some((frame:{phase:string})=>frame.phase==='canonicalDirectory'));
 }finally{f?.cleanup();if(process.platform==='win32')rmdirSync(alias);else unlinkSync(alias);rmdirSync(physical);rmdirSync(directory);}
});
test('boundary diagnostic maps native entry failure to safe fixed frames and status only',()=>{
 const f=fixture();try{
  f.env.PG_BIN_DIR=join(f.bin,'missing-SENTINEL');const diagnostic=boundaryDiagnostic(f);
  assert.equal(diagnostic.directoryCheck,true);assert.equal(diagnostic.canonicalEqual,true);assert.equal(diagnostic.ancestorReparse,false);assert.equal(diagnostic.ipcAcquired,true);assert.equal(diagnostic.ipcReleased,true);assert.equal(diagnostic.libraryBackup,false);assert.equal(diagnostic.nativeError,'ENOENT');assert.equal(diagnostic.nativeStatus,null);assert.ok(diagnostic.failureFrames.length>0);
  assert.doesNotMatch(JSON.stringify(diagnostic),/SENTINEL|postgresql:|file:\/\/|[A-Z]:\\/);
  f.env.PG_BIN_DIR=f.bin;const positive=boundaryDiagnostic(f);assert.equal(positive.libraryBackup,true);assert.equal(positive.nativeVersionValid,true);assert.equal(positive.nativeStatus,0);assert.deepEqual(positive.failureFrames,[]);
 }finally{f.cleanup();}
});
test('synthetic fixture uses the same native canonical path as the asynchronous production guard',async()=>{
 const f=fixture();try{
  const promised=await realpath(f.output);assert.equal(promised,realpathSync.native(f.output));assert.equal(f.output,promised);
 }finally{f.cleanup();}
});
