# Raut design system

Everything visual in the console derives from one place:
[`platform/src/lib/design-tokens.ts`](../platform/src/lib/design-tokens.ts).
Changing a colour there changes it everywhere, and `npm run test:contrast`
fails the build if the change breaks accessibility.

---

## 1. The palette comes from the logo

Not chosen to *go with* the mark — sampled *from* it. Three anchors:

| Role | Hex | Where it came from |
| --- | --- | --- |
| Brand | `#0078E8` | the X's body blue, the most-used saturated hue |
| Ink | `#000828` | the rounded square's navy |
| Light | `#F8F8F8` | the O and the S |

Neutrals are blue-cast rather than pure grey. A neutral or warm grey beside
this navy reads as a mismatch — the greys carry the same hue family.

### Two decisions the contrast test forced

- **Interactive surfaces use `brand-600` (#0165C4), not the raw logo blue.**
  White on `#0078E8` measures **4.33** — under AA's 4.5 for body text.
  `brand-600` is **5.74**. The logo blue still appears, as the chart series
  colour and as large display type, where 3:1 applies.
- **Danger red was darkened from `#DC2626` to `#B91C1C`.** The original
  measured **4.41** on its own tint. The test caught it; nobody would have
  noticed by eye.

Run it yourself:

```bash
cd platform && npm run test:contrast
```

It reads the same constants the app renders with, so it cannot drift from
reality. Adding a new foreground/background pairing to the UI means adding it
to `CONTRAST_ASSERTIONS` — otherwise it is untested.

---

## 2. Tokens, not values

`globals.css` defines CSS custom properties; `tailwind.config.ts` maps
utilities onto them. So `bg-surface` follows the active theme automatically and
a colour lives in exactly one place.

| Layer | Use |
| --- | --- |
| `bg`, `surface`, `surface-sunken`, `surface-hover` | backgrounds |
| `border`, `border-strong` | edges |
| `content`, `content-secondary`, `content-muted` | text, in descending emphasis |
| `accent`, `accent-hover`, `accent-subtle` | interactive |
| `success`, `warning`, `danger`, `info` (+ `-bg`, `-border`) | status, reserved |
| `chart-1` … `chart-6` | categorical series, fixed order |

**Prefer the semantic tokens over the raw ramps.** `bg-surface` survives a
theme change; `bg-ink-950` does not.

> One gotcha: Tailwind opacity modifiers (`bg-accent/50`) do not work on
> var-backed colours. Use `color-mix()` where a translucent brand tint is
> needed — it keeps the token indirection.

### Dark mode is selected, not flipped

The dark values are their own steps chosen against the dark surface, not a
programmatic inversion. `ThemeScript` applies the stored preference in a
blocking inline script before first paint, so there is no light-then-dark
flash. The toggle has three states — light, dark, **system** — and stores the
*choice*, not the resolved value; storing the resolved value would freeze a
user out of their OS setting the first time they toggled.

---

## 3. Components

Pages import from `@/components/ui`, never from the individual files.

| Component | Replaces |
| --- | --- |
| `DataTable` + `Column` | eleven hand-rolled `<table>` blocks that had already drifted |
| `PageHeader`, `SectionHeading` | ad-hoc heading markup |
| `StatCard`, `StatGrid`, `Meter` | bespoke stat tiles |
| `BarChart`, `RankedBars`, `CategoryBreakdown`, `GeoMap` | inline SVG per page |
| `Button`, `ButtonLink`, `Input`, `Select`, `Field`, `Toolbar`, `FilterTabs` | `.btn-primary`, `.input`, `.label` CSS classes |
| `Badge`, `StatusBadge`, `Callout`, `EmptyState`, `Skeleton` | scattered one-offs |
| `Can`, `CanOrUpgrade`, `ModuleLocked`, `ReadOnlyNotice` | inline permission checks |

### Why DataTable is column-driven

Before it, every list page wrote its own table. They had drifted: different
padding, different empty-state copy, and some without a scroll container — those
overflowed the page on a laptop. Describing columns instead of markup makes the
behaviour consistent by construction, including the `hideBelow` breakpoint that
keeps wide tables usable on a phone.

It is deliberately server-renderable. Sorting and filtering are URL state owned
by the page, not client state hidden in the component — that keeps rows
shareable, back-button-correct, and avoids shipping whole datasets to the
browser.

---

## 4. Charts

The chart palette is **validated, not eyeballed**:

```
light — all six checks pass
dark  — passes; the 5↔6 pair sits in the 6–8 CVD band
```

That band is only legal with secondary encoding, which is why every chart
direct-labels. In practice the console never exceeds four series.

Rules that hold everywhere:

- One axis. Never two y-scales.
- Categorical hues assigned in fixed order, never cycled. A seventh series
  folds into "Other" rather than inventing a hue.
- Colour is never the only carrier of meaning — labels and values sit beside
  every mark.
- Text wears text tokens, never the series colour.
- Grid and axes recessive; marks prominent.
- Status colours are reserved and never reused as a series.

`GeoMap` is a coordinate plot, not a tile map — basemap tiles need a Google or
Mapbox contract that the proposal excludes. It renders pins, territory fences
and route legs from stored coordinates, and is honest about being a plot.

---

## 5. Permissions are a UI concern

The rule: **a control the server will refuse must never look available.**

Route guards are the easy half. The half that bites is a page rendering a
button the API rejects on click — the user experiences that as the product
being broken, not as a permission boundary.

Two denial reasons, treated differently on purpose:

| Reason | Treatment | Why |
| --- | --- | --- |
| **Role** | hidden | Explaining an action they can never take is noise |
| **Module** | shown, disabled, module named | Not an error — a sales conversation. Hiding it conceals what the platform does |

`npm run test:permissions` signs in as each seeded role and asserts both
directions — what must be reachable, and what must be refused. **62 assertions
across six roles**, covering pages *and* the API behind them.

---

## 6. Verification

```bash
cd platform && npm run verify
```

| Check | Result |
| --- | --- |
| `test:contrast` — WCAG AA on every asserted pairing | **14/14** |
| `test:smoke` — API, auth, tenancy, module gating | **48/48** |
| `test:pages` — every console page renders real content | **24/24** |
| `test:brand` — logo assets served and referenced | **9/9** |
| `test:permissions` — role boundaries, UI and API | **62/62** |
| `test:integration` — offline → sync → console | **35/35** |

Mobile: `flutter analyze` clean, **44** unit tests, **9** on-device.

---

## 7. The Flutter app shares the palette

`mobile/raut_field/lib/theme.dart` carries the same ramp and the same status
colours. A rep and their manager read the same numbers on different screens; if
the two products look unrelated, they feel unrelated.

Two deliberate divergences, driven by where the app is used — outdoors, in
bright sun, one-handed:

- **52dp minimum tap targets**, above Material's 48dp. The failure mode here is
  a mis-tapped order.
- **Heavier type weights and higher contrast** than the web defaults.
