import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'daemon',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // node:sqlite is stable enough for us but still prints an ExperimentalWarning.
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});
