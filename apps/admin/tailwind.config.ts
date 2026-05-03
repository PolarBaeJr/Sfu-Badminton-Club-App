import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Non-negotiable: never pure white / pure black.
        // Override Tailwind's built-in palette so utilities like text-white,
        // bg-white/N, bg-black/N, shadow-black/N resolve to safe values.
        white: '#F2F2F2',
        black: '#0A0A0A',
      },
      fontFamily: {
        // Aligned with CLAUDE.md source of truth.
        display: ['Barlow Condensed', 'sans-serif'],
        body: ['Barlow', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
