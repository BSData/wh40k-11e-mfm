import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Keeps the tests' git away from the repository they run in (see the file).
    setupFiles: ['test/setup.ts'],
  },
});
