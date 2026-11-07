import {URL} from 'node:url';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {migrate} from '../../scripts/migrate';
import {seed} from '../../scripts/seed';
import {testDatabaseUrl} from './safety';
it('005 refuses legacy pending before schema changes and retains terminal history on controlled upgrade',async()=>{
 const schema=`stage8_upgrade_${crypto.randomUUID().replaceAll('-','')}`,url=new URL(testDatabaseUrl());url.searchParams.set('options',`-c search_path=${schema}`);
 const c=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:5000});await c.connect();let created=false;
 try{
  await c.query(`CREATE SCHEMA "${schema}"`);created=true;
  await c.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
  for(const name of ['001-core.sql','002-notifications.sql','003-identity.sql','004-client-flow.sql']){const sql=await readFile(new URL(`../../src/db/schema/${name}`,import.meta.url),'utf8');await c.query(sql);await c.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);}
  await seed(url.toString());
  const client=(await c.query("INSERT INTO clients(name) VALUES('Historical fixture') RETURNING id")).rows[0].id;
  const visit=(await c.query("INSERT INTO visits(client_id,barber_id,status,start_at,end_at,created_at) SELECT $1,id,'confirmed','2026-11-07T07:00Z','2026-11-07T08:00Z','2026-11-06T04:00Z' FROM barbers LIMIT 1 RETURNING id",[client])).rows[0].id;
  const transfer=(await c.query("INSERT INTO transfers(visit_id,initiator,status,new_start_at,new_end_at,deadline) VALUES($1,'staff','pending','2026-11-07T10:00Z','2026-11-07T11:00Z','2026-11-06T05:00Z') RETURNING id",[visit])).rows[0].id;
  await c.query("INSERT INTO visit_items(visit_id,service_id,name,price_kopecks,duration_minutes) SELECT $1,id,'Historical frozen item',123400,60 FROM services LIMIT 1",[visit]);
  await c.query("INSERT INTO audit_events(source,kind,entity_id,created_at,data) VALUES('system','historical_fixture',$1,'2026-11-06T04:00Z','{\"fixture\":true}')",[visit]);
  await c.query("INSERT INTO outbox(logical_key,kind,chat_id,payload,due_at,status,sent_at) VALUES('historical-fixture','start',100,'{\"text\":\"Historical fixture\"}','2026-11-06T04:00Z','sent','2026-11-06T04:00Z')");
  const history=async()=>({items:(await c.query('SELECT * FROM visit_items WHERE visit_id=$1',[visit])).rows,audit:(await c.query('SELECT * FROM audit_events WHERE entity_id=$1',[visit])).rows,outbox:(await c.query("SELECT * FROM outbox WHERE logical_key='historical-fixture'")).rows});
  const before=await history();const ledger=(await c.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
  await expect(migrate(url.toString())).rejects.toThrow('legacy pending transfers');
  expect((await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='visits' AND column_name='schedule_generation'",[schema])).rows).toHaveLength(0);
  expect((await c.query('SELECT status FROM transfers WHERE id=$1',[transfer])).rows[0].status).toBe('pending');
  expect(await history()).toEqual(before);expect((await c.query('SELECT * FROM schema_migrations ORDER BY name')).rows).toEqual(ledger);
  // This explicit, test-owned terminal transition models the existing app expiry resolving the guard.
  await c.query("UPDATE transfers SET status='expired',version=version+1 WHERE id=$1",[transfer]);
  await migrate(url.toString());await migrate(url.toString());
  expect(await history()).toEqual(before);
  expect((await c.query('SELECT status,initiator_user_id FROM transfers WHERE id=$1',[transfer])).rows).toEqual([{status:'expired',initiator_user_id:null}]);
  expect((await c.query('SELECT schedule_generation FROM visits WHERE id=$1',[visit])).rows[0].schedule_generation).toBe(1);
  expect((await c.query("SELECT name FROM schema_migrations WHERE name='005-consent-transfers.sql'")).rows).toHaveLength(1);
 }finally{if(created)await c.query(`DROP SCHEMA "${schema}" CASCADE`);await c.end();}
});
