/**
 * Raut design tokens — the single source of truth for the UI's visual language.
 *
 * Every colour here is either sampled from the logo artwork or derived from a
 * sampled value, because the brief is that the UI blends with the mark rather
 * than merely sitting near it. The sampled anchors are:
 *
 *   cyan   #0AB6D6   the left of the R's arm, the brightest brand hue
 *   teal   #05AC9D   where that arm resolves into green
 *   green  #43CC18   the location pin
 *   navy   #052744   the RAUT wordmark and the road
 *
 * Contrast is not a matter of taste, so it is asserted rather than assumed:
 * `npm run test:contrast` fails the build if any pairing below drops under
 * WCAG AA. Two decisions came directly out of that:
 *
 *   - Interactive surfaces use brand-600 (#076C80, 6.06), not the raw logo
 *     cyan. White on #0AB6D6 is 2.42 and on the next step down still only
 *     4.54 — too thin a margin to build a whole console on.
 *   - Muted text is slate-600 on light. slate-500 measures 4.33 and is
 *     reserved for large text only.
 *
 * The chart palette is validated separately for colour-vision deficiency; see
 * CHART_CATEGORICAL below.
 */

/** Tailwind-style ramp built around the cyan→teal of the R's arm. */
export const brand = {
  50: "#ECFAFD",
  100: "#D0F1F8",
  200: "#A5E5F1",
  300: "#6FD5E8",
  400: "#33C4DD",
  500: "#0AB6D6", // sampled from the logo's arm
  600: "#076C80", // interactive: white on this passes AA at 6.06
  700: "#075868",
  800: "#0A4A57",
  900: "#0B3D47",
} as const;

/**
 * The location pin's green, kept apart from `status.success`.
 *
 * Success has to mean one thing and one thing only; the pin green is a brand
 * gesture, used for the mark, the active-route accent and the tagline rule.
 */
export const accent = {
  400: "#43CC18", // sampled from the pin
  500: "#35A314",
  600: "#2A8110", // white on this passes AA at 4.95
} as const;

/**
 * Neutrals carry the logo's blue cast rather than being pure grey — a warm or
 * neutral grey beside this navy reads as a mismatch.
 */
export const slate = {
  50: "#F6F8FB",
  100: "#ECEFF5",
  200: "#DCE2EC",
  300: "#C2CBDA",
  400: "#94A0B8",
  500: "#6B7A96", // 4.33 on white — large text only
  600: "#4E5C78", // 6.72 on white — the muted body colour
  700: "#3A465E",
  800: "#232D42",
  900: "#0B2136",
  950: "#052744", // the RAUT wordmark's navy
} as const;

/** Status colours. Reserved — never reused as a chart series. */
export const status = {
  successFg: "#047857",
  successBg: "#ECFDF5",
  successBorder: "#A7F3D0",
  warningFg: "#B45309",
  warningBg: "#FFFBEB",
  warningBorder: "#FDE68A",
  // #DC2626 measures 4.41 on its own tint — just under AA. Stepped down.
  dangerFg: "#B91C1C",
  dangerBg: "#FEF2F2",
  dangerBorder: "#FECACA",
  infoFg: "#076C80",
  infoBg: "#ECFAFD",
  infoBorder: "#A5E5F1",
} as const;

/**
 * Categorical chart palette, assigned in fixed order and never cycled.
 *
 * Validated with the dataviz validator:
 *   light — all six checks pass
 *   dark  — passes, with the 5↔6 pair in the 6–8 CVD band, which is why every
 *           chart using five or more series must direct-label. In practice the
 *           console never exceeds four.
 */
export const CHART_CATEGORICAL = {
  light: ["#076C80", "#2A8110", "#B45309", "#7C3AED", "#1F6FB2", "#BE185D"],
  dark: ["#2FBBD2", "#63C93A", "#B87A1C", "#9575F0", "#5AA6E0", "#DB5C9C"],
} as const;

/** Sequential ramp for magnitude — one hue, light to dark. */
export const CHART_SEQUENTIAL = [
  brand[100], brand[200], brand[300], brand[400], brand[500], brand[700],
] as const;

/** Semantic surface tokens, resolved per theme in globals.css. */
export const semantic = {
  light: {
    bg: slate[50],
    surface: "#FFFFFF",
    surfaceSunken: slate[100],
    surfaceHover: slate[50],
    border: "#E3E8F0",
    borderStrong: slate[300],
    text: "#0F1729",
    textSecondary: slate[600],
    textMuted: slate[500],
    accent: brand[600],
    accentHover: brand[700],
    accentSubtle: brand[50],
    focus: brand[500],
    chartSurface: "#FFFFFF",
    chartGrid: "#EDF1F7",
  },
  dark: {
    bg: "#050B1C",
    surface: "#0B1430",
    surfaceSunken: "#070F26",
    surfaceHover: "#111C3A",
    border: "#1C2747",
    borderStrong: "#2A3860",
    text: "#E8EDF7",
    textSecondary: slate[300],
    textMuted: slate[400],
    accent: brand[400],
    accentHover: brand[300],
    accentSubtle: "#0F1E3D",
    focus: brand[400],
    chartSurface: "#0B1430",
    chartGrid: "#162242",
  },
} as const;

/** 4px base scale. */
export const space = {
  0.5: "2px", 1: "4px", 1.5: "6px", 2: "8px", 3: "12px",
  4: "16px", 5: "20px", 6: "24px", 8: "32px", 10: "40px", 12: "48px", 16: "64px",
} as const;

export const radius = {
  sm: "6px",
  md: "10px",
  lg: "14px",
  xl: "18px",
  full: "9999px",
} as const;

/**
 * Elevation is tinted with the brand navy rather than neutral black, so
 * shadows sit in the same colour family as everything else.
 */
export const elevation = {
  none: "none",
  sm: "0 1px 2px 0 rgb(0 8 40 / 0.05)",
  md: "0 2px 4px -1px rgb(0 8 40 / 0.06), 0 1px 2px -1px rgb(0 8 40 / 0.04)",
  lg: "0 8px 16px -4px rgb(0 8 40 / 0.10), 0 2px 6px -2px rgb(0 8 40 / 0.06)",
  xl: "0 20px 32px -8px rgb(0 8 40 / 0.16), 0 6px 12px -4px rgb(0 8 40 / 0.08)",
  focus: `0 0 0 3px ${brand[500]}33`,
} as const;

export const typography = {
  family:
    'ui-sans-serif, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: 'ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace',
  size: {
    xs: "11px", sm: "12.5px", base: "14px", md: "15px",
    lg: "17px", xl: "20px", "2xl": "24px", "3xl": "30px", "4xl": "38px",
  },
  weight: { normal: 400, medium: 500, semibold: 600, bold: 700 },
  leading: { tight: 1.2, snug: 1.35, normal: 1.5, relaxed: 1.65 },
} as const;

/**
 * Pairings the contrast test asserts. Adding a new foreground/background
 * combination to the UI means adding it here, so it cannot silently regress.
 */
export const CONTRAST_ASSERTIONS: Array<{
  name: string;
  fg: string;
  bg: string;
  min: number;
}> = [
  { name: "body text on surface (light)", fg: semantic.light.text, bg: semantic.light.surface, min: 4.5 },
  { name: "secondary text on surface (light)", fg: semantic.light.textSecondary, bg: semantic.light.surface, min: 4.5 },
  { name: "white on accent (light)", fg: "#FFFFFF", bg: semantic.light.accent, min: 4.5 },
  { name: "accent text on surface (light)", fg: semantic.light.accent, bg: semantic.light.surface, min: 4.5 },
  { name: "body text on bg (light)", fg: semantic.light.text, bg: semantic.light.bg, min: 4.5 },
  { name: "success on its tint", fg: status.successFg, bg: status.successBg, min: 4.5 },
  { name: "warning on its tint", fg: status.warningFg, bg: status.warningBg, min: 4.5 },
  { name: "danger on its tint", fg: status.dangerFg, bg: status.dangerBg, min: 4.5 },
  { name: "info on its tint", fg: status.infoFg, bg: status.infoBg, min: 4.5 },

  { name: "body text on surface (dark)", fg: semantic.dark.text, bg: semantic.dark.surface, min: 4.5 },
  { name: "secondary text on surface (dark)", fg: semantic.dark.textSecondary, bg: semantic.dark.surface, min: 4.5 },
  { name: "muted text on surface (dark)", fg: semantic.dark.textMuted, bg: semantic.dark.surface, min: 4.5 },
  { name: "accent text on surface (dark)", fg: semantic.dark.accent, bg: semantic.dark.surface, min: 4.5 },
  { name: "body text on bg (dark)", fg: semantic.dark.text, bg: semantic.dark.bg, min: 4.5 },
];
