import type { Config } from 'tailwindcss';

const config: Partial<Config> = {
  theme: {
    extend: {
      fontFamily: {
        display: ['Barlow Condensed', 'sans-serif'],
        body: ['DM Sans', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
};

export default config;
