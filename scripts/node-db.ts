import pg from 'pg';
import { databaseFromClients, type Database, type SqlClient } from '../src/db/client.ts';

// CLI/integration TCP boundary. Runtime uses Neon WebSockets; repository SQL is shared.
export function nodeDatabase(url: string): Database {
  return databaseFromClients(nodeClients(url));
}
export function nodeClients(url: string): { createClient(): SqlClient } {
  return { createClient() {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 4000 });
    client.on('error', () => {});
    return client as unknown as SqlClient;
  } };
}
