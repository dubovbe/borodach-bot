import { probeDatabase } from '../src/db/probe.ts';
import { probeTransaction } from '../src/db/probe-transaction.ts';
import { writeSync } from 'node:fs';

function finish(result: object, exitCode: number): never {
  // Flush the single small result before exit, even if the driver retains handles.
  writeSync(process.stdout.fd, JSON.stringify(result) + '\n');
  process.exit(exitCode);
}

// Independent from Worker, Telegram and Wrangler. Node 24 has native WebSocket.
setTimeout(() => {
  finish({ ok: false, code: 'PROBE_TIMEOUT' }, 1);
}, 12000);
let ok = false;
try {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Missing configuration');
  if (!(await probeDatabase(url)).ok) throw new Error('HTTP probe failed');
  ok = (await probeTransaction(url)).ok;
} catch {
  ok = false;
}
finish(ok ? { ok: true, http: true, transaction: true } : { ok: false, code: 'NEON_PROBE_FAILED' }, ok ? 0 : 1);
