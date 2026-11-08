import pg from 'pg';
import {mkdtemp,readFile,readdir,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {migrate} from './migrate.ts';
import {seed} from './seed.ts';
import {backup,restore,connection} from './backup-ops.ts';
import {isMain} from './http-ops.ts';
// CI-only local proof. Remote exercise and comprehensive fixtures remain parent-owned.
export async function recoveryCheck(env:Record<string,string|undefined>):Promise<void>{
 const base=new URL(env.TEST_DATABASE_URL??'');const parsed=connection(base.href);
 if(!['localhost','127.0.0.1','[::1]'].includes(parsed.host))throw Error('RECOVERY_CHECK_FAILED');
 const id=randomUUID().replaceAll('-',''),sourceName=`stage11_fixture_${id}`,targetName=`stage11_restore_${id}`,schema='stage11_recovery';
 const admin=new pg.Client({connectionString:base.href,connectionTimeoutMillis:5000,query_timeout:5000});
 const directory=await mkdtemp(join(tmpdir(),'stage11-recovery-'));let sourceCreated=false,targetCreated=false;
 const source=new URL(base.href),target=new URL(base.href);source.pathname='/'+sourceName;target.pathname='/'+targetName;source.search='?sslmode=disable';target.search='?sslmode=disable';
 const scoped=new URL(source.href);scoped.searchParams.set('options',`-c search_path=${schema}`);
 try{
  await admin.connect();await admin.query(`CREATE DATABASE "${sourceName}"`);sourceCreated=true;await admin.query(`CREATE DATABASE "${targetName}"`);targetCreated=true;
  const fixture=new pg.Client({connectionString:scoped.href,connectionTimeoutMillis:5000,query_timeout:5000});await fixture.connect();
  try{await fixture.query(`CREATE SCHEMA "${schema}"`);await migrate(scoped.href);await seed(scoped.href);await fixture.query("WITH u AS (INSERT INTO telegram_users(telegram_id,last_seen_at) VALUES(110001,'2026-11-06T04:00:00Z') RETURNING id) INSERT INTO roles(user_id,role) SELECT id,'admin' FROM u");}finally{await fixture.end();}
  const ops={BACKUP_DATABASE_URL:source.href,RESTORE_DATABASE_URL:target.href,BACKUP_SCHEMA:schema,BACKUP_DIR:directory,PG_BIN_DIR:env.PG_BIN_DIR,SYNTHETIC_TEST:'true',SOURCE_CODE_SHA:env.SOURCE_CODE_SHA};
  await backup(ops);const archive=(await readdir(directory)).find(name=>name.endsWith('.dump'));if(!archive)throw Error('RECOVERY_CHECK_FAILED');
  await restore({...ops,RESTORE_ARCHIVE:join(directory,archive)});
  async function rows(url:string){const client=new pg.Client({connectionString:url,connectionTimeoutMillis:5000,query_timeout:5000});await client.connect();try{const tables=(await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',[schema])).rows;const result:Record<string,unknown>={};for(const {tablename} of tables)result[tablename]=(await client.query(`SELECT to_jsonb(t) data FROM "${schema}"."${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;return JSON.stringify(result);}finally{await client.end();}}
  if(await rows(source.href)!==await rows(target.href))throw Error('RECOVERY_CHECK_FAILED');
  // Also verify the paired manifest remains readable; restore never starts a runtime sender.
  JSON.parse(await readFile(join(directory,archive+'.json'),'utf8'));
 }finally{
  if(targetCreated)await admin.query(`DROP DATABASE "${targetName}"`);if(sourceCreated)await admin.query(`DROP DATABASE "${sourceName}"`);await admin.end();
  for(const name of await readdir(directory))await unlink(join(directory,name));await rmdir(directory);
 }
}
if(isMain(import.meta.url)){try{await recoveryCheck(process.env);console.log(JSON.stringify({ok:true,recovery:true}));}catch{console.log(JSON.stringify({ok:false,code:'RECOVERY_CHECK_FAILED'}));process.exitCode=1;}}
