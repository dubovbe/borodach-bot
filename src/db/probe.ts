import { neon } from '@neondatabase/serverless';

// One read, no retries; cancellation covers network time and response reading.
export async function probeDatabase(url: string): Promise<{ ok: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const sql = neon(url, { fetchOptions: { signal: controller.signal } });
    const rows = await sql`SELECT 1 AS ok`;
    return { ok: rows.length === 1 && rows[0].ok === 1 };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}
