/**
 * Vitest config for the dev harness self-tests (dev/*.test.ts):
 *   npx vitest run --config dev/vitest.config.ts
 * The root config includes them too, so `npm test` runs them with the card's own tests; this
 * config runs only the harness tests.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    environment: 'happy-dom',
    include: ['dev/**/*.test.ts'],
  },
});
