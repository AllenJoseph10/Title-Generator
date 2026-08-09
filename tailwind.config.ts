import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '1.5rem',
      screens: { '2xl': '1440px' },
    },
    extend: {
      colors: {
        // Editorial dark palette — bone on near-black with deep oxblood accent.
        bg: {
          DEFAULT: '#0a0a0a',
          raised: '#131313',
          inset: '#1a1a1a',
        },
        ink: {
          DEFAULT: '#f5f0e6',       // primary text — bone
          dim: '#a8a39a',            // secondary
          muted: '#6b6760',          // tertiary / labels
          faint: '#3f3c37',          // dividers
        },
        accent: {
          DEFAULT: '#8a1c2b',       // deep oxblood — primary action
          hover: '#a32434',
          subtle: '#2a0e12',
        },
        gold: '#c9a96e',             // champagne — used sparingly
        positive: '#6f9e6a',          // muted sage for "high" strength
        warning: '#c9a96e',           // gold for "med"
        neutral: '#6b6760',           // muted for "low"
        border: {
          DEFAULT: '#2a2825',
          strong: '#3f3c37',
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        display: ['var(--font-fraunces)', 'Georgia', 'serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        // Editorial scale — tighter than default
        'micro': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.08em' }], // 11px
        'xs': ['0.75rem', { lineHeight: '1rem' }],
        'sm': ['0.8125rem', { lineHeight: '1.25rem' }],
        'base': ['0.875rem', { lineHeight: '1.4rem' }],
        'lg': ['1rem', { lineHeight: '1.5rem' }],
        'xl': ['1.125rem', { lineHeight: '1.6rem' }],
        '2xl': ['1.375rem', { lineHeight: '1.75rem' }],
        '3xl': ['1.75rem', { lineHeight: '2.1rem' }],
        'display': ['2.5rem', { lineHeight: '2.75rem', letterSpacing: '-0.02em' }],
      },
      borderRadius: {
        DEFAULT: '2px',
        sm: '2px',
        md: '4px',
        lg: '6px',
      },
      animation: {
        'fade-in': 'fadeIn 200ms ease-out',
        'slide-up': 'slideUp 220ms ease-out',
        // Landing-page pipeline animation. `both` fill mode holds the start
        // state through the delay, which is what makes staggering work.
        'rise-in': 'slideUp 280ms ease-out both',
        'drop-in': 'dropIn 460ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'grow-x': 'growX 520ms ease-out both',
        sweep: 'sweep 1700ms ease-in-out infinite',
        // Entrance for the two columns once a clip is loaded.
        'panel-in': 'panelIn 420ms cubic-bezier(0.22, 1, 0.36, 1) both',
        // Indeterminate progress: a segment sweeping the length of a track.
        track: 'trackSlide 1500ms cubic-bezier(0.65, 0, 0.35, 1) infinite',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        dropIn: {
          '0%': { opacity: '0', transform: 'translateY(-30px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        growX: {
          '0%': { transform: 'scaleX(0)' },
          '100%': { transform: 'scaleX(1)' },
        },
        panelIn: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        trackSlide: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(300%)' },
        },
        sweep: {
          '0%': { top: '-15%' },
          '100%': { top: '105%' },
        },
      },
    },
  },
};

export default config;
