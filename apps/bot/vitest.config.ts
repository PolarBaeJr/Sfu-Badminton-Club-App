import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // dist/ holds the tsc output. Without this, a build before a test run makes
    // vitest execute every suite twice - once from source, once from the
    // compiled copy - which doubles the count and hides nothing useful.
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
