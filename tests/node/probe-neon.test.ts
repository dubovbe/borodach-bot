import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// A CLI crash, provider exception dump or zero exit status on failed config is a regression.
test('independent probe fails closed with sanitized stdout and nonzero exit', () => {
  const result = spawnSync(process.execPath, ['scripts/probe-neon.ts'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, DATABASE_URL: 'invalid-url-with-fake-password' },
  });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { ok: false, code: 'NEON_PROBE_FAILED' });
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /fake-password/);
});

// Replace only the external driver import; retain the real CLI and both shared probes.
// A real ref'ed interval proves that Promise.race finishing does not end a process.
function runWithHeldDriverHandle(hangingEnd: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'borodach-probe-test-'));
  const preload = join(directory, 'driver.mjs');
  const driver = `
    export const neonConfig = {};
    export function neon() { return async () => [{ ok: 1 }]; }
    export class Client {
      on() {}
      async connect() {}
      async query() { return { rows: [{ ok: 1 }] }; }
      end() {
        setInterval(() => {}, 1000);
        return ${hangingEnd ? 'new Promise(() => {})' : 'Promise.resolve()'};
      }
    }
  `;
  writeFileSync(preload, `
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === '@neondatabase/serverless') return {
          url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(driver))}, shortCircuit: true
        };
        return nextResolve(specifier, context);
      }
    });
  `);
  const started = Date.now();
  try {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, 'scripts/probe-neon.ts'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 14000,
      env: { ...process.env, DATABASE_URL: 'postgresql://fake:fake-password@ep-test.neon.tech/test' },
    });
    return { ...result, elapsed: Date.now() - started };
  } finally {
    unlinkSync(preload);
    rmdirSync(directory);
  }
}

test('hanging driver cleanup cannot keep CLI alive or produce duplicate results', () => {
  const result = runWithHeldDriverHandle(true);
  assert.equal(result.error, undefined, 'CLI must exit itself, not be killed by the subprocess harness');
  assert.equal(result.status, 1);
  assert.ok(result.elapsed < 13000, `CLI exceeded hard deadline: ${result.elapsed}ms`);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { ok: false, code: 'NEON_PROBE_FAILED' });
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /fake-password/);
});

test('successful CLI flushes one result and exits zero despite a retained driver handle', () => {
  const result = runWithHeldDriverHandle(false);
  assert.equal(result.error, undefined, 'CLI must exit itself, not be killed by the subprocess harness');
  assert.equal(result.status, 0);
  assert.ok(result.elapsed < 13000, `CLI exceeded hard deadline: ${result.elapsed}ms`);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { ok: true, http: true, transaction: true });
  assert.equal(result.stderr, '');
});
