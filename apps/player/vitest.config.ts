import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Mirrors apps/admin. The `@` alias is the reason this file exists at all:
// without it vitest still ran, but nothing importing `@/lib/...` could be
// tested — which is every module in this app worth testing, and is a large part
// of why the player app had one test file while admin had eighteen.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // See the file: supabase-js will not construct without a global WebSocket,
    // which Node 20 (CI) lacks and Node 22+ (dev) has.
    setupFiles: ['./vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
