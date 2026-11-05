import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { withClient } from '../src/db/client.ts';
import { nodeClients } from './node-db.ts';

export async function migrate(url: string): Promise<void> {
  await withClient(nodeClients(url), async (client) => {
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query("SET LOCAL statement_timeout = '4s'");
      // Serializes all migration runners, including the initial ledger creation.
      await client.query('SELECT pg_advisory_xact_lock($1)', [676202602]);
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
      const directory = new URL('../src/db/schema/', import.meta.url);
      const names = (await readdir(directory)).filter((name) => /^\d+[-\w]*\.sql$/.test(name)).sort();
      for (const name of names) {
        const sql = await readFile(new URL(name, directory), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const previous = await client.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
        if (previous.rows.length) {
          if (previous.rows[0].checksum !== checksum) throw new Error('Migration checksum mismatch');
          continue;
        }
        // SQL is a checked-in migration, never user input.
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name,checksum]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) { console.error('TEST_DATABASE_URL is required'); process.exitCode = 1; }
  else { try { await migrate(url); console.log('Migrations applied'); } catch { console.error('Migration failed'); process.exitCode = 1; } }
}
