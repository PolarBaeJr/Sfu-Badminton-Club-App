import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    // Reference design is sharp-cornered: zero the whole radius scale so every
    // rounded-* class flattens app-wide. `full` stays for avatars/pill dots;
    // dialogs opt back in with literal rounded-[16px]/[8px] (bypasses the scale).
    borderRadius: {
      none: '0',
      sm: '0',
      DEFAULT: '0',
      md: '0',
      lg: '0',
      xl: '0',
      '2xl': '0',
      '3xl': '0',
      full: '9999px',
    },
    extend: {
      colors: {
        primary: '#1A1A2E',
        accent: '#c00',
        surface: '#111',
        background: '#0a0a0a',
      },
      fontFamily: {
        display: ['var(--font-display)', 'Barlow Condensed', 'sans-serif'],
        body: ['var(--font-sans)', 'Barlow', 'sans-serif'],
        sans: ['var(--font-sans)', 'Barlow', 'sans-serif'],
        mono: ['var(--font-mono)', 'JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
