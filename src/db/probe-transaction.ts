import { Client, neonConfig } from '@neondatabase/serverless';

export async function probeTransaction(url: string): Promise<{ ok: boolean }> {
  neonConfig.webSocketConstructor = WebSocket;
  let client: Client | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  let ok = false;
  try {
    client = new Client({ connectionString: url, connectionTimeoutMillis: 2000,
      query_timeout: 2000, statement_timeout: 2000 });
    client.on('error', () => {}); // Socket errors must not expose connection details.
    const connection = client;
    const run = async () => {
      await connection.connect();
      let selected = false;
      for (const sql of ['BEGIN', 'SELECT 1 AS ok', 'ROLLBACK']) {
        if (expired) throw new Error('Probe expired');
        const result = await connection.query(sql);
        if (sql === 'SELECT 1 AS ok') selected = result.rows.length === 1 && result.rows[0].ok === 1;
      }
      return selected;
    };
    ok = await Promise.race([run(), new Promise<boolean>((_resolve, reject) => {
      deadline = setTimeout(() => { expired = true; reject(new Error('Probe expired')); }, 6000);
    })]);
  } catch {
    ok = false;
  } finally {
    clearTimeout(deadline);
    if (client) {
      try {
        // Closing also rolls back an unfinished read-only transaction after failure.
        const closed = await Promise.race([client.end().then(() => true), new Promise<boolean>((resolve) => {
          cleanupDeadline = setTimeout(() => resolve(false), 1000);
        })]);
        if (!closed) ok = false;
      } catch { ok = false; }
      finally { clearTimeout(cleanupDeadline); }
    }
  }
  return { ok };
}
