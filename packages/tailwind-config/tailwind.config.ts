import type { Config } from 'tailwindcss/types/config';

/**
 * Flowkite design system — "soft machine".
 *
 * Neumorphism supplies the ground: a near-white canvas where every surface is
 * extruded from the same material by light alone, never by borders.
 * Skeuomorphism supplies the controls: graphite slabs with a lit top rim and a
 * shaded base, so they read as physical keys sitting on that canvas.
 *
 * Two rules keep the two idioms from fighting each other:
 *   1. Light always falls from the top-left. Every shadow pair obeys it.
 *   2. Only interactive or emphasised things are graphite. The canvas stays pale.
 */
export default {
  theme: {
    extend: {
      colors: {
        // Pale canvas. Deliberately off-white: a pure #fff ground cannot show a
        // white highlight, which is what makes neumorphic extrusion legible.
        canvas: {
          DEFAULT: '#eef0f4',
          sunk: '#e6e9ee',
          raised: '#f4f6f9',
          pure: '#ffffff',
        },
        // Graphite controls — the black→gray gradient family.
        graphite: {
          50: '#f5f6f8',
          100: '#e3e5ea',
          200: '#c3c7d0',
          300: '#9aa0ad',
          400: '#6b7280',
          500: '#4a4f58',
          600: '#33373e',
          700: '#23262b',
          800: '#16181c',
          900: '#0d0e11',
          950: '#08090b',
        },
        ink: {
          DEFAULT: '#14161a',
          soft: '#454b55',
          // 5.06:1 on canvas, 5.34:1 on canvas-raised, 4.75:1 on canvas-sunk — this
          // carries real content (timestamps, field hints), so it has to clear AA.
          faint: '#5f6673',
        },
        // The one hue that is not graphite or a status: what carries emphasis inside agent prose -
        // the key term in a sentence, a literal value, a section label. Violet rather than the
        // orange every other assistant uses, so a Flowkite answer is recognisably Flowkite's.
        // 5.54:1 on canvas and 5.84:1 on canvas-raised, so emphasis never costs legibility.
        accent: {
          DEFAULT: '#6b4bb8',
          strong: '#553a94',
          // chip ground for inline literals; the violet above clears 4.7:1 on it
          soft: '#ece7f7',
        },
        // Restrained status hues, desaturated to sit calmly on the pale ground.
        signal: {
          ok: '#2f8f5b',
          warn: '#b07d1a',
          bad: '#c0453f',
          info: '#3f6ea8',
        },
      },
      backgroundImage: {
        // The control gradient: lit shoulder at the top, falling to near-black.
        graphite: 'linear-gradient(160deg, #3c414a 0%, #1c1f24 52%, #0c0d10 100%)',
        'graphite-hover': 'linear-gradient(160deg, #4a505a 0%, #24282e 52%, #101216 100%)',
        'graphite-active': 'linear-gradient(160deg, #16181c 0%, #23262b 52%, #34383f 100%)',
        // The destructive twin of the graphite family, built the same way: lit shoulder, darker
        // base, and inverted when pressed. Desaturated to sit on the pale ground rather than shout
        // at it. The mid stop clears 5.8:1 against the graphite-50 text the keys carry, so the
        // label stays readable where it actually sits.
        danger: 'linear-gradient(160deg, #c4544d 0%, #a83a34 52%, #7d221e 100%)',
        'danger-hover': 'linear-gradient(160deg, #d1615a 0%, #b8443d 52%, #8e2a25 100%)',
        'danger-active': 'linear-gradient(160deg, #7d221e 0%, #8e2a25 52%, #a83a34 100%)',
        // A brushed sheen for larger slabs, so big surfaces are not flat black.
        sheen: 'linear-gradient(105deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 38%)',
        // Deliberately NOT named `canvas`: a backgroundImage key of that name emits a
        // second `.bg-canvas` rule that wins over the flat colour of the same name.
        'canvas-sheen': 'linear-gradient(150deg, #f3f5f8 0%, #eaedf2 100%)',
      },
      boxShadow: {
        // Neumorphic pairs — pale ground, light from the top-left.
        'neu-sm': '3px 3px 7px rgba(159,167,183,0.42), -3px -3px 7px rgba(255,255,255,0.92)',
        neu: '7px 7px 15px rgba(159,167,183,0.45), -7px -7px 15px rgba(255,255,255,0.95)',
        'neu-lg': '14px 14px 30px rgba(159,167,183,0.45), -12px -12px 26px rgba(255,255,255,0.95)',
        'neu-inset': 'inset 4px 4px 9px rgba(159,167,183,0.50), inset -4px -4px 9px rgba(255,255,255,0.95)',
        'neu-inset-sm': 'inset 2px 2px 5px rgba(159,167,183,0.45), inset -2px -2px 5px rgba(255,255,255,0.92)',

        // Skeuomorphic graphite keys: outer drop + inner rim light + inner base shade.
        key: '0 8px 16px rgba(24,28,36,0.28), 0 2px 4px rgba(24,28,36,0.22), inset 0 1px 0 rgba(255,255,255,0.22), inset 0 -1px 0 rgba(0,0,0,0.55)',
        'key-sm':
          '0 4px 9px rgba(24,28,36,0.26), 0 1px 2px rgba(24,28,36,0.20), inset 0 1px 0 rgba(255,255,255,0.20), inset 0 -1px 0 rgba(0,0,0,0.50)',
        'key-lg':
          '0 16px 30px rgba(24,28,36,0.30), 0 4px 8px rgba(24,28,36,0.22), inset 0 1px 0 rgba(255,255,255,0.24), inset 0 -1px 0 rgba(0,0,0,0.55)',
        // Pressed: the key sinks, the outer drop collapses, the inside darkens.
        'key-pressed':
          '0 1px 2px rgba(24,28,36,0.24), inset 0 2px 6px rgba(0,0,0,0.60), inset 0 -1px 0 rgba(255,255,255,0.10)',
        // A hairline that reads as a bevel rather than a border.
        bevel: 'inset 0 1px 0 rgba(255,255,255,0.85), inset 0 -1px 0 rgba(159,167,183,0.30)',
      },
      borderRadius: {
        soft: '0.875rem',
        slab: '1.25rem',
        pill: '999px',
      },
      fontFamily: {
        sans: ['ui-sans-serif', '-apple-system', 'BlinkMacSystemFont', 'Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'SF Mono', 'Menlo', 'monospace'],
      },
      transitionTimingFunction: {
        press: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      },
      keyframes: {
        'fk-rise': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fk-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.45' },
        },
      },
      animation: {
        rise: 'fk-rise 0.28s cubic-bezier(0.2, 0.8, 0.2, 1) both',
        'pulse-soft': 'fk-pulse 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} as Omit<Config, 'content'>;
