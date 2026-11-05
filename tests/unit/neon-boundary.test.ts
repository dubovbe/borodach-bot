import { expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ config: {} as Record<string,unknown>, connect: vi.fn(async () => {}), end: vi.fn(async () => {}), query: vi.fn(async () => ({ rows: [], rowCount: 0 })), neonConfig: {} as Record<string,unknown> }));
vi.mock('@neondatabase/serverless', () => ({ neonConfig: f.neonConfig, Client: class {
  constructor(config: Record<string,unknown>) { f.config = config; }
  on() {} connect = f.connect; end = f.end; query = f.query;
} }));
import { createDatabase } from '../../src/db/client';
it('runtime_neon_uses_websocket_and_bounded_connection_and_queries', async () => {
  await createDatabase('postgres://test@example/db').read(async (sql) => sql.query('SELECT $1', [1]));
  expect(f.neonConfig.webSocketConstructor).toBe(WebSocket);
  expect(f.config).toMatchObject({ connectionTimeoutMillis: 3000, query_timeout: 5000, statement_timeout: 4000 });
  expect(f.query).toHaveBeenCalledWith('SELECT $1', [1]); expect(f.end).toHaveBeenCalledOnce();
});
