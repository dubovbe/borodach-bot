import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {URL} from 'node:url';
import {expect,it} from 'vitest';
import {testDatabaseUrl} from './safety';
import {migrate} from '../../scripts/migrate';
import {seed} from '../../scripts/seed';
it('006 preserves 005 ledger/history bytes and is idempotent with owner/version constraints',async()=>{
 const schema=`entry10_${crypto.randomUUID().replaceAll('-','')}`,url=new URL(testDatabaseUrl());url.searchParams.set('options',`-c search_path=${schema}`);
 const sql=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:5000});await sql.connect();let created=false;
 try{
  await sql.query(`CREATE SCHEMA "${schema}"`);created=true;await sql.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
  for(const name of ['001-core.sql','002-notifications.sql','003-identity.sql','004-client-flow.sql','005-consent-transfers.sql']){
   const text=await readFile(new URL(`../../src/db/schema/${name}`,import.meta.url),'utf8');await sql.query(text);await sql.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,createHash('sha256').update(text).digest('hex')]);
  }
  await seed(url.toString());const uid=(await sql.query('INSERT INTO telegram_users(telegram_id,last_seen_at) VALUES(100,clock_timestamp()) RETURNING id')).rows[0].id;
  const cid=(await sql.query("INSERT INTO clients(user_id,name,phone) VALUES($1,'Вымышленный Клиент','+79123456100') RETURNING id",[uid])).rows[0].id;
  const vid=(await sql.query("INSERT INTO visits(client_id,barber_id,status,start_at,end_at,created_at) VALUES($1,'00000000-0000-4000-8000-000000000002','cancelled','2026-11-06T07:00:00Z','2026-11-06T07:45:00Z',clock_timestamp()) RETURNING id",[cid])).rows[0].id;
  await sql.query("INSERT INTO audit_events(update_id,actor_id,kind,entity_id,created_at,data) VALUES(100,$1,'visit_cancelled',$2,clock_timestamp(),'{\"reason\":\"История\"}')",[uid,vid]);
  const before={ledger:(await sql.query('SELECT * FROM schema_migrations ORDER BY name')).rows,visits:(await sql.query('SELECT * FROM visits')).rows,audit:(await sql.query('SELECT * FROM audit_events')).rows};
  await migrate(url.toString());await migrate(url.toString());
  expect((await sql.query("SELECT * FROM schema_migrations WHERE name<>'006-entry-callbacks.sql' ORDER BY name")).rows).toEqual(before.ledger);
  expect((await sql.query('SELECT * FROM visits')).rows).toEqual(before.visits);expect((await sql.query('SELECT * FROM audit_events')).rows).toEqual(before.audit);
  expect((await sql.query("SELECT * FROM schema_migrations WHERE name='006-entry-callbacks.sql'")).rows).toHaveLength(1);
  expect((await sql.query('SELECT * FROM entry_callbacks')).rows).toHaveLength(0);
  await expect(sql.query("INSERT INTO entry_callbacks(user_id,visit_id,visit_version,action,expires_at) VALUES($1,$2,0,'new_booking',clock_timestamp())",[uid,vid])).rejects.toMatchObject({code:'23514'});
  await expect(sql.query("INSERT INTO entry_callbacks(user_id,visit_id,visit_version,action,expires_at) VALUES($1,$2,1,'cancel',clock_timestamp())",[uid,vid])).rejects.toMatchObject({code:'23514'});
 }finally{if(created)await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await sql.end();}
},120000);
