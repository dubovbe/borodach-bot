import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID,X509Certificate} from 'node:crypto';
import {readFile,writeFile,rename,unlink,readdir,realpath,lstat,stat} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,dirname,basename,parse} from 'node:path';
import {fileURLToPath,URL} from 'node:url';
import {isMain} from './http-ops.ts';
import {operationLock} from './operation-lock.ts';
type OpsEnv=Record<string,string|undefined>;
export type Connection={host:string;port:string;database:string;user:string;password:string;sslmode:string;channelBinding:string;identity:string;caPath?:string};
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const fail=():never=>{throw Error('OPS_FAILED');};
const canonicalHost=(host:string)=>['localhost','127.0.0.1','[::1]'].includes(host.toLowerCase())?'localhost':host.toLowerCase().replace(/-pooler\./g,'.').replace(/\.$/,'');
export function connection(value:string|undefined):Connection{
 try{
  const url=new URL(value??'');
  if(!['postgresql:','postgres:'].includes(url.protocol)||url.hash||!url.hostname||!url.username||!url.password||!/^\/[^/]+$/.test(url.pathname))return fail();
  const user=decodeURIComponent(url.username),password=decodeURIComponent(url.password),database=decodeURIComponent(url.pathname.slice(1)),host=url.hostname;
  // libpq expands dbname values containing '=' as conninfo in pg_restore --dbname.
  if(!user||!password||!database||[user,password,database,host].some(s=>/[\x00-\x1f\x7f]/.test(s))||/[\/=]/.test(database)||! /^(?:[a-z0-9][a-z0-9.-]*|\[[a-f0-9:]+\])$/i.test(host)||/-pooler\./i.test(host))return fail();
  const port=url.port||'5432';if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535)return fail();
  const keys=[...url.searchParams.keys()];if(keys.some(k=>!['sslmode','channel_binding'].includes(k))||new Set(keys).size!==keys.length)return fail();
  const loopback=['localhost','127.0.0.1','[::1]'].includes(host.toLowerCase());
  const ssl=url.searchParams.get('sslmode')??'verify-full';
  if(!['require','verify-full'].includes(ssl)&&!(loopback&&ssl==='disable'))return fail();
  const channelBinding=url.searchParams.get('channel_binding')??'prefer';if(!['require','prefer','disable'].includes(channelBinding))return fail();
  return {host,port,database,user,password,sslmode:ssl==='require'?'verify-full':ssl,channelBinding,identity:hash(`${canonicalHost(host)}:${port}/${database}`)};
 }catch{return fail();}
}
function childEnv(c:Connection):NodeJS.ProcessEnv{
 const result:NodeJS.ProcessEnv={};
 for(const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL'])if(process.env[key])result[key]=process.env[key];
 return {...result,PGHOST:c.host,PGPORT:c.port,PGDATABASE:c.database,PGUSER:c.user,PGPASSWORD:c.password,PGSSLMODE:c.sslmode,PGCHANNELBINDING:c.channelBinding,PGCONNECT_TIMEOUT:'5',PGAPPNAME:'stage11-offline-ops',...(c.sslmode==='verify-full'?{PGSSLROOTCERT:c.caPath??'system'}:{})};
}
// All executable invocations have finite time/output and no shell or connection URL argv.
export async function utility(executable:string,args:string[],env:NodeJS.ProcessEnv,timeout=30000):Promise<string>{
 return new Promise((accept,reject)=>{
  const child=spawn(executable,args,{shell:false,windowsHide:true,env,stdio:['ignore','pipe','pipe']});
  let output='',size=0,failed=false;
  let killTimer:ReturnType<typeof setTimeout>|undefined;
  const stop=()=>{if(failed)return;failed=true;child.kill();killTimer=setTimeout(()=>child.kill('SIGKILL'),500);};
  const timer=setTimeout(stop,timeout);
  child.stdout.on('data',(data:Buffer)=>{size+=data.length;if(size>4*1024*1024)stop();else output+=data.toString('utf8');});
  child.stderr.on('data',(data:Buffer)=>{size+=data.length;if(size>4*1024*1024)stop();});
  child.on('error',()=>{clearTimeout(timer);clearTimeout(killTimer);reject(Error('OPS_FAILED'));});
  child.on('close',code=>{clearTimeout(timer);clearTimeout(killTimer);if(failed||code!==0)reject(Error('OPS_FAILED'));else accept(output);});
 });
}
type Tools={psql:string;dump:string;restore:string};
function tools(env:OpsEnv):Tools{
 const dir=env.PG_BIN_DIR;if(dir&&!isAbsolute(dir))return fail();
 const executable=(name:string)=>dir?join(dir,name+(process.platform==='win32'?'.exe':'')):name;
 return {psql:executable('psql'),dump:executable('pg_dump'),restore:executable('pg_restore')};
}
const sql=(t:Tools,c:Connection,query:string)=>utility(t.psql,['-X','-w','-q','-A','-t','--set=ON_ERROR_STOP=1','--command',`BEGIN READ ONLY; SET LOCAL statement_timeout='4s'; ${query}; COMMIT;`],childEnv(c));
async function inspect(t:Tools,c:Connection){
 const info=JSON.parse((await sql(t,c,"SELECT json_build_object('database',current_database(),'version',current_setting('server_version_num')::integer)")).trim());
 if(info.database!==c.database||Math.floor(Number(info.version)/10000)!==18)return fail();
 return info as {database:string;version:number};
}
async function versions(t:Tools,c:Connection){
 const result:Record<string,string>={};for(const [key,executable] of Object.entries(t)){
  const value=(await utility(executable,['--version'],childEnv(c))).trim(),version=value.match(/^[a-z_]+ \(PostgreSQL\) (18\.\d+)(?:\D|$)/);if(!version)return fail();
  result[key]=`PostgreSQL 18/${version[1]}`;
 }return result;
}
const schemaName=(value:string|undefined)=>value&&/^[a-z_][a-z0-9_]{0,62}$/.test(value)&&!value.startsWith('pg_')&&value!=='information_schema'?value:fail();
const inside=(directory:string,path:string)=>{const rel=relative(directory,path);return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel));};
async function canonicalDirectory(value:string|undefined){
 if(!value||!isAbsolute(value))return fail();const full=resolve(value),actual=await realpath(full);
 if(!(await stat(actual)).isDirectory())return fail();
 for(let p=full;;p=dirname(p)){if((await lstat(p)).isSymbolicLink())return fail();if(p===parse(p).root)break;}
 const normalize=(p:string)=>process.platform==='win32'?p.toLowerCase():p;
 if(normalize(full)!==normalize(actual))return fail();return actual;
}
async function configuration(env:OpsEnv,restore=false){
 const source=connection(env.BACKUP_DATABASE_URL),schema=schemaName(env.BACKUP_SCHEMA),directory=await canonicalDirectory(env.BACKUP_DIR);
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 const synthetic=env.SYNTHETIC_TEST==='true';
 if(synthetic&&!/^stage11_fixture_[a-f0-9]{32}$/.test(source.database))return fail();
 if(inside(root,directory)&&!synthetic)return fail();
 const target=restore?connection(env.RESTORE_DATABASE_URL):undefined;
 if(target&&(source.identity===target.identity||synthetic&&!/^stage11_restore_[a-f0-9]{32}$/.test(target.database)))return fail();
 if(env.PG_SSL_ROOT_CERT){
  if(!isAbsolute(env.PG_SSL_ROOT_CERT))return fail();
  const parent=await canonicalDirectory(dirname(env.PG_SSL_ROOT_CERT));
  const ca=await checkedFile(parent,env.PG_SSL_ROOT_CERT),data=await readFile(ca,'utf8');
  const blocks=data.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if(data.length>1024*1024||!blocks?.length||data.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,'').trim())return fail();
  for(const block of blocks)new X509Certificate(block);
  source.caPath=ca;if(target)target.caPath=ca;
 }
 return {source,target,schema,directory,tools:tools(env)};
}
type Migration={name:string;checksum:string};
type Manifest={format:1;sourceIdentity:string;schema:string;codeSha?:string;serverVersion:number;tools:Record<string,string>;migrations:Migration[];migrationSources:Array<Migration&{base64:string}>;archive:string;sha256:string;bytes:number;successAt:string};
function prefix(c:Connection,schema:string){return `stage11-${c.identity}-${schema}-`;}
async function checkedFile(directory:string,path:string){
 const full=resolve(path);if(!inside(directory,full)||dirname(full)!==directory||(await lstat(full)).isSymbolicLink()||!(await stat(full)).isFile())return fail();return full;
}
function validateManifest(value:unknown,c:Connection,schema:string):Manifest{
 const m=value as Manifest;
 if(!m||m.format!==1||m.sourceIdentity!==c.identity||m.schema!==schema||!/^stage11-[a-f0-9]{64}-[a-z_][a-z0-9_]*-[0-9TZa-f-]+\.dump$/.test(m.archive)||!m.archive.startsWith(prefix(c,schema))||!Number.isSafeInteger(m.bytes)||m.bytes<1||!/^[a-f0-9]{64}$/.test(m.sha256)||!Number.isFinite(Date.parse(m.successAt))||Math.floor(m.serverVersion/10000)!==18||m.codeSha!==undefined&&!/^[a-f0-9]{40}$/.test(m.codeSha)||!Array.isArray(m.migrations)||!m.migrations.length||m.migrations.some(v=>!/^\d+[-\w]*\.sql$/.test(v.name)||!/^[a-f0-9]{64}$/.test(v.checksum))||!m.tools||Object.keys(m.tools).sort().join(',')!=='dump,psql,restore'||Object.values(m.tools).some(v=>!/^PostgreSQL 18\/18\.\d+$/.test(v)))return fail();
 if(!Array.isArray(m.migrationSources)||m.migrationSources.length!==m.migrations.length||m.migrations.some((entry,i)=>{
  const source=m.migrationSources[i];return !source||source.name!==entry.name||source.checksum!==entry.checksum||typeof source.base64!=='string'||hash(Buffer.from(source.base64,'base64'))!==entry.checksum;
 }))return fail();
 return m;
}
export function validateList(list:string,schema:string):void{
 if(!/^;\s+Dumped from database version: 18\.\d+(?:\D|$)/m.test(list)||!/^;\s+Dumped by pg_dump version: 18\.\d+(?:\D|$)/m.test(list))return fail();
 let objects=0;
 for(const line of list.split(/\r?\n/)){
  if(!line.trim()||line.startsWith(';'))continue;
  const entry=line.match(/^\d+;\s+\d+\s+\d+\s+(.+)$/);if(!entry)return fail();
  const body=entry[1];
  if(body.startsWith(`SCHEMA - ${schema} `)||body.startsWith(`COMMENT - SCHEMA ${schema} `)){objects++;continue;}
  // Accept only schema-contained object kinds; never database/global/session entries.
  const object=body.match(/^(?:SEQUENCE OWNED BY|SEQUENCE SET|TABLE DATA|FK CONSTRAINT|CHECK CONSTRAINT|TABLE ATTACH|INDEX ATTACH|DEFAULT ACL|ROW SECURITY|MATERIALIZED VIEW DATA|MATERIALIZED VIEW|TABLE|SEQUENCE|CONSTRAINT|INDEX|DEFAULT|FUNCTION|PROCEDURE|TYPE|DOMAIN|VIEW|TRIGGER|RULE|POLICY|COMMENT)\s+(\S+)\s+/);
  if(!object||object[1]!==schema)return fail();objects++;
 }if(!objects)return fail();
}
async function scoped(t:Tools,c:Connection,schema:string){
 // pg_identify_object includes namespace for constraints, routines, types and relations.
 const cross=Number((await sql(t,c,`SELECT count(*) FROM pg_depend d CROSS JOIN LATERAL pg_identify_object(d.classid,d.objid,d.objsubid) o CROSS JOIN LATERAL pg_identify_object(d.refclassid,d.refobjid,d.refobjsubid) r WHERE o.schema='${schema}' AND r.schema IS NOT NULL AND r.schema NOT IN ('${schema}','pg_catalog','information_schema')`)).trim());
 if(cross!==0)return fail();
 const migrations=JSON.parse((await sql(t,c,`SELECT COALESCE(json_agg(json_build_object('name',name,'checksum',checksum) ORDER BY name),'[]'::json) FROM "${schema}".schema_migrations`)).trim());
 if(!Array.isArray(migrations)||!migrations.length||migrations.some(v=>!/^\d+[-\w]*\.sql$/.test(v.name)||!/^[a-f0-9]{64}$/.test(v.checksum)))return fail();return migrations;
}
async function digest(path:string){
 const hasher=createHash('sha256');let bytes=0;
 for await(const chunk of createReadStream(path)){bytes+=chunk.length;hasher.update(chunk);}
 return {bytes,sha256:hasher.digest('hex')};
}
async function successful(directory:string,c:Connection,schema:string){
 const result:Array<{path:string;manifest:Manifest}>=[];
 for(const name of await readdir(directory)){
  if(!name.startsWith(prefix(c,schema))||!name.endsWith('.dump.json'))continue;
  try{const path=await checkedFile(directory,join(directory,name)),manifest=validateManifest(JSON.parse(await readFile(path,'utf8')),c,schema);if(name!==manifest.archive+'.json')continue;const archive=await checkedFile(directory,join(directory,manifest.archive));const data=await digest(archive);if(data.bytes!==manifest.bytes||data.sha256!==manifest.sha256)continue;result.push({path,manifest});}catch{/* Unrelated or incomplete bundles are never retention candidates. */}
 }
 return result.sort((a,b)=>b.manifest.successAt.localeCompare(a.manifest.successAt)||b.manifest.archive.localeCompare(a.manifest.archive));
}
export async function backup(env:OpsEnv):Promise<{ok:true;backup:true;retention:boolean}>{
 const c=await configuration(env),release=await operationLock(c.directory,prefix(c.source,c.schema)+'operation');
 const name=prefix(c.source,c.schema)+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().replaceAll('-','')+'.dump';
 const partial=join(c.directory,name+'.partial'),archive=join(c.directory,name),manifestPath=archive+'.json';let published=false;
 try{
  const v=await versions(c.tools,c.source),info=await inspect(c.tools,c.source),migrations=await scoped(c.tools,c.source,c.schema);
  const migrationSources=await Promise.all((migrations as Migration[]).map(async migration=>{
   const bytes=await readFile(new URL(`../src/db/schema/${migration.name}`,import.meta.url));
   if(hash(bytes)!==migration.checksum)return fail();return {...migration,base64:bytes.toString('base64')};
  }));
  if(env.SOURCE_CODE_SHA&&!/^[a-f0-9]{40}$/.test(env.SOURCE_CODE_SHA))return fail();
  await utility(c.tools.dump,['-w','--format=custom','--strict-names',`--schema=${c.schema}`,'--no-owner','--no-acl','--file',partial],childEnv(c.source),120000);
  const content=await digest(await checkedFile(c.directory,partial));if(!content.bytes)return fail();
  validateList(await utility(c.tools.restore,['--list',partial],childEnv(c.source)),c.schema);
  const manifest:Manifest={format:1,sourceIdentity:c.source.identity,schema:c.schema,...(env.SOURCE_CODE_SHA?{codeSha:env.SOURCE_CODE_SHA}:{}),serverVersion:info.version,tools:v,migrations,migrationSources,archive:name,...content,successAt:new Date().toISOString()};
  await writeFile(manifestPath+'.partial',JSON.stringify(manifest,null,2),{flag:'wx'});
  await rename(partial,archive);await rename(manifestPath+'.partial',manifestPath);published=true;
  // Publishing the validated manifest is the success boundary. A later prune failure
  // must not misreport a successful backup as failed or hide its updated age.
  let retention=true;
  try{for(const stale of (await successful(c.directory,c.source,c.schema)).slice(7)){
    const owned=await checkedFile(c.directory,join(c.directory,stale.manifest.archive));
    await unlink(owned);await unlink(await checkedFile(c.directory,stale.path));
  }}catch{retention=false;}
  return {ok:true,backup:true,retention};
 }finally{
  for(const path of [partial,manifestPath+'.partial',...(!published?[archive]:[])]){try{await unlink(await checkedFile(c.directory,path));}catch{/* no recursive or unowned cleanup */}}
  await release();
 }
}
export async function backupStatus(env:OpsEnv):Promise<{ok:true;available:boolean;ageSeconds:number|null}>{
 const c=await configuration(env);const last=(await successful(c.directory,c.source,c.schema))[0];return {ok:true,available:!!last,ageSeconds:last?Math.max(0,Math.floor((Date.now()-Date.parse(last.manifest.successAt))/1000)):null};
}
export async function restore(env:OpsEnv):Promise<{ok:true;restored:true}>{
 const c=await configuration(env,true),target=c.target!;
 if(!env.RESTORE_ARCHIVE||!isAbsolute(env.RESTORE_ARCHIVE))return fail();
 const archive=await checkedFile(c.directory,env.RESTORE_ARCHIVE),manifestPath=await checkedFile(c.directory,archive+'.json');
 const manifest=validateManifest(JSON.parse(await readFile(manifestPath,'utf8')),c.source,c.schema);
 if(basename(archive)!==manifest.archive)return fail();const content=await digest(archive);if(content.bytes!==manifest.bytes||content.sha256!==manifest.sha256)return fail();
 const release=await operationLock(c.directory,prefix(c.source,c.schema)+'operation');
 try{
  // The validated bundle establishes source identity/version even if its server is lost.
  await versions(c.tools,target);await inspect(c.tools,target);
  validateList(await utility(c.tools.restore,['--list',archive],childEnv(target)),c.schema);
  const count=Number((await sql(c.tools,target,"SELECT (SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname !~ '^pg_') + (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_') + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_') + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_')")).trim());
  if(count!==0)return fail();
  await utility(c.tools.restore,['-w','--exit-on-error','--single-transaction','--no-owner','--no-acl','--dbname',target.database,archive],childEnv(target),120000);
  return {ok:true,restored:true};
 }finally{await release();}
}
if(isMain(import.meta.url)){
 const mode=process.argv[2];try{
  const result=mode==='backup'?await backup(process.env):mode==='restore'?await restore(process.env):mode==='status'?await backupStatus(process.env):fail();
  console.log(JSON.stringify(result));
  if('retention' in result&&!result.retention)process.exitCode=2;
 }catch{console.log(JSON.stringify({ok:false,code:mode==='restore'?'RESTORE_FAILED':mode==='status'?'BACKUP_STATUS_FAILED':'BACKUP_FAILED'}));process.exitCode=1;}
}
