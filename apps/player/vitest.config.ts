import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Mirrors apps/admin. The `@` alias is the reason this file exists at all:
// without it vitest still ran, but nothing importing `@/lib/...` could be
// tested — which is every module in this app worth testing, and is a large part
// of why the player app had one test file while admin had eighteen.
export default defineConfig({
  // tsconfig.base.json sets `jsx: preserve`, which is right for Next and wrong
  // for vitest: vite hands the file to esbuild, esbuild leaves the JSX in, and
  // the import fails to parse. Anything with a .tsx in its import graph was
  // therefore untestable -- which is why the Discord card, the one module whose
  // whole output is pixels, could only ever be asserted against as SOURCE TEXT.
  // See __tests__/discord-card-render.test.ts.
  // `oxc`, NOT `esbuild`: vite 8 transforms through rolldown/oxc and ignores
  // the esbuild block entirely, so the obvious spelling of this fails silently
  // and the error still points at the tsconfig.
  //
  // And the value is an OBJECT, not the string 'automatic'. The string is
  // accepted at runtime and the tests go green on it, but `jsx` types as
  // `'preserve' | JsxOptions` -- so the string only fails later, in `next
  // build`, which type-checks this file too.
  oxc: { jsx: { runtime: 'automatic' } },
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
