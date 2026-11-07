/**
 * Raut design tokens: the single source of truth for the UI's visual language.
 *
 * The palette comes from the East African landscape. Laterite, the red earth of
 * the Rift Valley and the Tsavo roads, carries everything interactive. Savanna
 * sand warms the neutrals. Acacia green, ochre and Indian Ocean indigo appear in
 * the bead pattern. The logo keeps its own teal and green, and teal stays in use
 * for informational states so the mark still belongs on the page.
 *
 * Contrast is not a matter of taste, so it is asserted rather than assumed:
 * `npm run test:contrast` fails the build if any pairing below drops under
 * WCAG AA.
 *
 * The chart palette is validated separately for colour-vision deficiency; see
 * CHART_CATEGORICAL below.
 */

/** Tailwind-style ramp built around laterite. */
export const brand = {
  50: "#FDF3EC",
  100: "#FAE3D3",
  200: "#F4C7A8",
  300: "#EBA478",
  400: "#E07F4B",
  500: "#D2622C",
  600: "#A8441C", // interactive: white on this passes AA at 5.98
  700: "#8C3716",
  800: "#6F2C13",
  900: "#57240F",
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

/** Warm neutrals: savanna sand through to dark earth. */
export const slate = {
  50: "#FAF6EF",
  100: "#F3ECDF",
  200: "#E8DDCB",
  300: "#D4C5AE",
  400: "#A8977F",
  500: "#6F5F4C", // muted text, AA on the page and on cards
  600: "#5E5142",
  700: "#463B2F",
  800: "#2E261E",
  900: "#1F1913",
  950: "#15110C",
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
  infoFg: "#0B6A78",
  infoBg: "#E8F6F7",
  infoBorder: "#A9DCE2",
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
    surface: "#FFFDF9",
    surfaceSunken: slate[100],
    surfaceHover: slate[50],
    border: "#E8DFCF",
    borderStrong: slate[300],
    text: "#211A14",
    textSecondary: slate[600],
    textMuted: slate[500],
    accent: brand[600],
    accentHover: brand[700],
    accentSubtle: brand[50],
    focus: brand[500],
    chartSurface: "#FFFDF9",
    chartGrid: "#EFE7D9",
  },
  dark: {
    bg: "#120E0A",
    surface: "#1C1610",
    surfaceSunken: "#16110C",
    surfaceHover: "#251D15",
    border: "#32281E",
    borderStrong: "#463A2C",
    text: "#F3ECDF",
    textSecondary: slate[300],
    textMuted: slate[400],
    accent: brand[400],
    accentHover: brand[300],
    accentSubtle: "#2B1C12",
    focus: brand[400],
    chartSurface: "#1C1610",
    chartGrid: "#2A2118",
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

  // The sidebar is navy in both colour schemes; these cover its text pairings.
  { name: "sidebar body (light)", fg: "#F3ECDF", bg: "#15100B", min: 4.5 },
  { name: "sidebar secondary (light)", fg: "#D4C5AE", bg: "#15100B", min: 4.5 },
  { name: "sidebar accent (light)", fg: "#EBA478", bg: "#15100B", min: 4.5 },
  { name: "sidebar subtle", fg: "#B3A38C", bg: "#15100B", min: 4.5 },
  { name: "muted text on page (light)", fg: slate[500], bg: semantic.light.bg, min: 4.5 },
  { name: "muted text on surface (light)", fg: slate[500], bg: semantic.light.surface, min: 4.5 },
  { name: "white on dark earth", fg: "#FFFFFF", bg: "#15110C", min: 4.5 },
  { name: "laterite label on dark earth", fg: "#EBA478", bg: "#15110C", min: 4.5 },
  { name: "sidebar active text", fg: "#FFFFFF", bg: "#A8441C", min: 4.5 },
];
