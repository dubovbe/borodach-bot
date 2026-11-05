import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

// Fail closed before any connection. No fallback to the runtime environment.
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  const runtimeUrls = [process.env.DATABASE_URL];
  for (const file of ['.env','.dev.vars']) {
    try {
      const content = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      runtimeUrls.push(content.match(/^DATABASE_URL\s*=\s*['"]?([^'"\r\n]+)/m)?.[1]);
    } catch { /* CI has no runtime files. */ }
  }
  return assertIsolatedTestDatabase(url, runtimeUrls);
}

export function assertIsolatedTestDatabase(url: string | undefined, runtimeUrls: (string | undefined)[]): string {
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  const parse = (value: string) => {
    try { return new URL(value); } catch { throw new Error('Invalid database URL'); }
  };
  const target = parse(url);
  const canonical = (host: string) => host.toLowerCase().replace('-pooler.', '.');
  if (runtimeUrls.some((runtime) => runtime && canonical(parse(runtime).hostname) === canonical(target.hostname))) {
    throw new Error('Test and runtime database hosts must differ');
  }
  if (!['postgres:', 'postgresql:'].includes(target.protocol)) throw new Error('PostgreSQL URL required');
  return url;
}
