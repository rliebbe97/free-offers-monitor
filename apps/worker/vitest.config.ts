import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Set dummy env vars required by config.ts module-load-time validation
    env: {
      ANTHROPIC_API_KEY: 'test-key',
      REDDIT_CLIENT_ID: 'test-client-id',
      REDDIT_CLIENT_SECRET: 'test-client-secret',
      REDDIT_REFRESH_TOKEN: 'test-refresh-token',
      VOYAGE_API_KEY: 'test-voyage-key',
    },
  },
});
