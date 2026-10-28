import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [react()],
  test: {
    name: 'desktop',
    // scripts/: build tooling (Node; tests opt out of jsdom with @vitest-environment node).
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.js'],
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
  },
});
