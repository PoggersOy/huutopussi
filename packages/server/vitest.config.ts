import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@hp/engine': r('../engine/src/index.ts'),
      '@hp/protocol': r('../protocol/src/index.ts'),
      '@hp/bots': r('../bots/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
