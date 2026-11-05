import { Client, neonConfig } from '@neondatabase/serverless';
import type { Instant } from '../domain/types';

interface RawSqlReader {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}
export interface SqlClient extends RawSqlReader { connect(): Promise<void>; end(): Promise<void> }
export interface SqlReader { query<T>(text: string, values: unknown[]): Promise<T[]> }
export type Tx = SqlReader & { now: Instant };
export interface Database {
  read<T>(run: (sql: SqlReader) => Promise<T>): Promise<T>;
  transaction<T>(run: (tx: Tx) => Promise<T>): Promise<T>;
}
interface ClientFactory { createClient(): SqlClient }

export function createDatabase(url: string): Database {
  return databaseFromClients({ createClient() {
    neonConfig.webSocketConstructor = WebSocket;
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000, query_timeout: 5000, statement_timeout: 4000 });
    client.on('error', () => {}); // Provider errors may contain credentials. Never log them.
    return client as unknown as SqlClient;
  } });
}

export function databaseFromClients(factory: ClientFactory): Database {
  const reader = (client: SqlClient): SqlReader => ({ async query<T>(text: string, values: unknown[]) {
    return (await client.query(text, values)).rows as T[];
  } });
  return {
    read: (run) => withClient(factory, (client) => run(reader(client))),
    transaction: (run) => withClient(factory, async (client) => {
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL lock_timeout = '3s'");
        await client.query("SET LOCAL statement_timeout = '4s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '5s'");
        const shop = await client.query('SELECT id FROM shop WHERE id=$1 FOR UPDATE', [1]);
        if (shop.rows.length !== 1) throw new Error('Shop singleton is missing');
        const clock = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
        const result = await run({ ...reader(client), now: clock.rows[0].now.toISOString() });
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }),
  };
}

export async function withClient<T>(database: ClientFactory, run: (client: SqlClient) => Promise<T>): Promise<T> {
  const client = database.createClient();
  try { await client.connect(); return await run(client); }
  finally {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([client.end(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Database close timeout')), 1000);
      })]);
    } finally { clearTimeout(timer); }
  }
}
