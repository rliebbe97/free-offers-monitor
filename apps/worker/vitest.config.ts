import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Set dummy env vars required by config.ts module-load-time validation
    env: {
      ANTHROPIC_API_KEY: 'test-key',
      VOYAGE_API_KEY: 'test-voyage-key',
    },
  },
});
