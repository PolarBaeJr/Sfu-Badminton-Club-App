import type { Config } from 'tailwindcss';

const config: Partial<Config> = {
  theme: {
    extend: {
      fontFamily: {
        // Aligned with CLAUDE.md source of truth.
        display: ['Barlow Condensed', 'sans-serif'],
        body: ['Barlow', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
};

export default config;
