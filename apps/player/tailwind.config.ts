import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class', '[data-theme="dark"]'],
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    // Kept identical to apps/admin/tailwind.config.ts on purpose: the two apps
    // share packages/ui, so a component rendered in both would round by
    // different amounts depending on which app compiled it if these drifted.
    //
    // The scale was zeroed app-wide for a sharp-cornered reference design. The
    // owner asked for rounded boxes on 2026-09-17, so it carries real values
    // again and the rounded-* classes already written throughout the app start
    // taking effect at once. Values match the literals people wrote to get a
    // corner while the scale was zero: md === rounded-[8px], xl === the
    // rounded-[16px] on Dialog. rounded-none is now the only way to keep a
    // corner square, so the sites using it stay sharp on purpose.
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
        // shadcn/ui CSS variable colors
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)',
        },
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)',
        },
        // App-specific brand colors — themed via CSS vars
        'court-red': 'var(--color-accent)',
        gold: 'var(--color-gold)',
        'shuttle-white': 'var(--text-primary)',
        'deep-navy': 'var(--bg-primary)',
        'card-dark': 'var(--bg-card)',
        surface: 'var(--bg-surface)',
      },
      fontFamily: {
        display: ['var(--font-display)', 'Barlow Condensed', 'sans-serif'],
        body: ['var(--font-sans)', 'Barlow', 'sans-serif'],
        sans: ['var(--font-sans)', 'Barlow', 'sans-serif'],
        mono: ['var(--font-mono)', 'JetBrains Mono', 'monospace'],
      },
      animation: {
        'shuttle-float': 'shuttleFloat 3s ease-in-out infinite',
        'pulse-glow': 'pulseGlow 2s ease-in-out infinite',
        'slide-up': 'slideUp 0.5s ease-out',
      },
      keyframes: {
        shuttleFloat: {
          '0%, 100%': { transform: 'translateY(0px) rotate(0deg)' },
          '50%': { transform: 'translateY(-10px) rotate(5deg)' },
        },
        pulseGlow: {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
