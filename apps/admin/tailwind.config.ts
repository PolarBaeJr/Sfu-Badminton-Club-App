import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    // The scale was zeroed app-wide for a sharp-cornered reference design. The
    // owner asked for rounded boxes on 2026-09-17, so it carries real values
    // again and the ~150 rounded-* classes already written throughout both apps
    // start taking effect at once — no sweep of call sites, because they were
    // never removed.
    //
    // THE VALUES DELIBERATELY MATCH THE LITERALS ALREADY IN THE CODE, which are
    // what the scale's zeroes forced people to write to get a corner at all:
    // md === the 23 rounded-[8px] controls and rounded-[var(--r-control,8px)],
    // xl === Dialog's rounded-[16px]. Picking anything else would leave the
    // opted-in sites and the scale sites disagreeing by a few pixels, which
    // reads as sloppiness rather than as two different intentions.
    //
    // rounded-none becomes load-bearing here. While the scale was zero it was a
    // no-op restating the default; now it is the only way a corner stays square,
    // so the 14 sites using it keep their sharp edges on purpose.
    borderRadius: {
      none: '0',
      sm: '4px',
      DEFAULT: '6px',
      md: '8px',
      lg: '12px',
      xl: '16px',
      '2xl': '20px',
      '3xl': '24px',
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
