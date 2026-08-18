import type { Config } from "tailwindcss";

/**
 * Tailwind is wired to the CSS custom properties in globals.css rather than to
 * literal hex values. A utility like `bg-surface` therefore follows the active
 * theme automatically, and a colour is defined in exactly one place.
 *
 * Consequence worth knowing: opacity modifiers (`bg-accent/50`) do not work on
 * var-backed colours unless the variable holds a bare channel triple. Where a
 * translucent brand tint is needed, use `color-mix` in the component — that
 * keeps the token indirection intact instead of hard-coding a hex.
 */
export default {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // semantic — prefer these in components
        bg: "var(--bg)",
        surface: "var(--surface)",
        "surface-sunken": "var(--surface-sunken)",
        "surface-hover": "var(--surface-hover)",
        border: "var(--border)",
        "border-strong": "var(--border-strong)",
        content: "var(--text)",
        "content-secondary": "var(--text-secondary)",
        "content-muted": "var(--text-muted)",
        accent: "var(--accent)",
        "accent-hover": "var(--accent-hover)",
        "accent-subtle": "var(--accent-subtle)",

        success: {
          DEFAULT: "var(--success-fg)",
          bg: "var(--success-bg)",
          border: "var(--success-border)",
        },
        warning: {
          DEFAULT: "var(--warning-fg)",
          bg: "var(--warning-bg)",
          border: "var(--warning-border)",
        },
        danger: {
          DEFAULT: "var(--danger-fg)",
          bg: "var(--danger-bg)",
          border: "var(--danger-border)",
        },
        info: {
          DEFAULT: "var(--info-fg)",
          bg: "var(--info-bg)",
          border: "var(--info-border)",
        },

        // raw ramps, for the few places a specific step is meant
        brand: {
          50: "var(--brand-50)", 100: "var(--brand-100)", 200: "var(--brand-200)",
          300: "var(--brand-300)", 400: "var(--brand-400)", 500: "var(--brand-500)",
          600: "var(--brand-600)", 700: "var(--brand-700)", 800: "var(--brand-800)",
          900: "var(--brand-900)",
        },
        ink: {
          50: "var(--slate-50)", 100: "var(--slate-100)", 200: "var(--slate-200)",
          300: "var(--slate-300)", 400: "var(--slate-400)", 500: "var(--slate-500)",
          600: "var(--slate-600)", 700: "var(--slate-700)", 800: "var(--slate-800)",
          900: "var(--slate-900)", 950: "var(--slate-950)",
        },

        chart: {
          1: "var(--chart-1)", 2: "var(--chart-2)", 3: "var(--chart-3)",
          4: "var(--chart-4)", 5: "var(--chart-5)", 6: "var(--chart-6)",
          grid: "var(--chart-grid)",
        },
      },

      borderRadius: {
        sm: "var(--radius-sm)",
        DEFAULT: "var(--radius-md)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
      },

      boxShadow: {
        sm: "var(--shadow-sm)",
        DEFAULT: "var(--shadow-md)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        xl: "var(--shadow-xl)",
      },

      fontFamily: {
        sans: [
          "ui-sans-serif", "system-ui", "Segoe UI", "Roboto",
          "Helvetica Neue", "Arial", "sans-serif",
        ],
        mono: ["ui-monospace", "SF Mono", "Cascadia Code", "Consolas", "monospace"],
      },

      fontSize: {
        xs: ["11px", { lineHeight: "1.45" }],
        sm: ["12.5px", { lineHeight: "1.45" }],
        base: ["14px", { lineHeight: "1.5" }],
        md: ["15px", { lineHeight: "1.5" }],
        lg: ["17px", { lineHeight: "1.4" }],
        xl: ["20px", { lineHeight: "1.3" }],
        "2xl": ["24px", { lineHeight: "1.25" }],
        "3xl": ["30px", { lineHeight: "1.2" }],
        "4xl": ["38px", { lineHeight: "1.15" }],
      },

      spacing: {
        header: "var(--header-h)",
        sidebar: "var(--sidebar-w)",
      },

      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(2px)" },
          to: { opacity: "1", transform: "none" },
        },
        shimmer: { "100%": { transform: "translateX(100%)" } },
      },
      animation: {
        "fade-in": "fade-in 160ms ease-out",
        shimmer: "shimmer 1.4s infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
