import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
  // JSX, so a test may IMPORT a component and not only the maths under it.
  //
  // The app's tsconfig sets `jsx: "preserve"` because Next does its own
  // transform, which leaves vitest unable to parse a single .tsx file — and the
  // chart panels on /fees and /seasons are exactly the code whose branches a
  // pure-function test cannot reach. An empty state that silently stopped
  // rendering would pass every assertion in charts.test.ts.
  //
  // `oxc` and not `esbuild`: vitest 4 transforms with oxc, and setting the
  // esbuild key is accepted, warned about and then ignored — a config that
  // looks right and does nothing.
  //
  // The automatic runtime so no test file has to import React to be compiled.
  // This changes nothing for the tests that existed before it: none of them
  // imports a component, and this option only decides how JSX is compiled,
  // never whether a module is loaded.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
