import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { bindings: {
      BOT_TOKEN: '123456:test-token',
      BOT_INFO: JSON.stringify({ id: 123456, is_bot: true, first_name: 'Test', username: 'test_bot' }),
      WEBHOOK_SECRET: 'test-webhook-secret',
      DATABASE_URL: 'postgresql://test:fake-password@ep-test.eu-central-1.aws.neon.tech/test?sslmode=require',
      FIRST_ADMIN_ID: '100',
    } },
  })],
  test: { include: ['tests/worker/**/*.test.ts'] },
});
