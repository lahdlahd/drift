import { defineConfig } from 'vitest/config';

// Only Drift's own tests; research/m0-probe has its own node:test suite.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
