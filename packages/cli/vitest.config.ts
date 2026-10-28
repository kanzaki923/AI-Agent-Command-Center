import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'cli',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The e2e test starts a real daemon (node:sqlite prints an ExperimentalWarning).
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});
