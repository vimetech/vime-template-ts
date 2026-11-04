import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Local runs read the repository .env. CI provides the variables directly (existing variables win).
const rootEnv = new URL('../../.env', import.meta.url);
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

export default defineConfig({
  test: {
    globalSetup: ['./src/testing/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
