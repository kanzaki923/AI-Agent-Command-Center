import { defineConfig } from 'vitest/config';

// Each package/app with its own vitest.config.ts becomes a separate project.
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
  },
});
