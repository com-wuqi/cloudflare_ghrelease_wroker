import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const TEST_SESSION_SECRET = 'test-session-secret-0123456789abcdef0123456789';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.example.jsonc' },
      miniflare: {
        bindings: {
          REPOS: 'example/app,other-org/other-repo',
          TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
          TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
          SESSION_SECRET: TEST_SESSION_SECRET,
          SESSION_TTL_SECONDS: '3600',
          // Always refetch metadata so tests never depend on the edge cache.
          RELEASE_CACHE_TTL: '0',
          VERIFY_LIMIT_PER_HOUR: '1000',
          DOWNLOAD_LIMIT_PER_HOUR: '1000',
          ADMIN_TOKEN: 'test-admin-token-0123456789abcdef',
          ADMIN_LIMIT_PER_HOUR: '1000',
          METRICS_RETENTION_DAYS: '30',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.spec.ts'],
    testTimeout: 20000,
  },
});
