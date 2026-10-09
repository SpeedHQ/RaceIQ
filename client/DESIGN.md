---
name: RaceIQ
description: Multi-game racing telemetry dashboard with AI-powered lap coaching
colors:
  app-bg: "var(--app-bg)"
  app-surface: "var(--app-surface)"
  app-surface-alt: "var(--app-surface-alt)"
  app-surface-hover: "var(--app-surface-hover)"
  app-progress-track: "var(--app-progress-track)"
  app-dropdown: "var(--app-dropdown)"
  app-border: "var(--app-border)"
  app-border-input: "var(--app-border-input)"
  app-border-hover: "var(--app-border-hover)"
  app-text: "var(--app-text)"
  app-text-secondary: "var(--app-text-secondary)"
  app-text-muted: "var(--app-text-muted)"
  app-text-dim: "var(--app-text-dim)"
  app-on-filled: "var(--app-on-filled)"
  app-accent: "var(--app-accent)"
  app-accent-hover: "var(--app-accent-hover)"
  app-highlight: "var(--app-highlight)"
  status-success: "var(--status-success)"
  status-success-hover: "var(--status-success-hover)"
  status-warning: "var(--status-warning)"
  status-danger: "var(--status-danger)"
  status-danger-hover: "var(--status-danger-hover)"
  status-info: "var(--status-info)"
  status-unavailable: "var(--status-unavailable)"
  severity-nominal: "var(--severity-nominal)"
  severity-caution: "var(--severity-caution)"
  severity-warning: "var(--severity-warning)"
  severity-critical: "var(--severity-critical)"
  operating-cold: "var(--operating-cold)"
typography:
  title:
    fontFamily: "var(--font-sans)"
    fontSize: "var(--text-app-title)"
  heading:
    fontFamily: "var(--font-sans)"
    fontSize: "var(--text-app-heading)"
  body:
    fontFamily: "var(--font-sans)"
    fontSize: "var(--text-app-body)"
  subtext:
    fontFamily: "var(--font-sans)"
    fontSize: "var(--text-app-subtext)"
  detail:
    fontFamily: "var(--font-sans)"
    fontSize: "var(--text-app-detail)"
  label:
    fontFamily: "var(--font-sans)"
    fontSize: "var(--text-app-label)"
  compact:
    fontFamily: "var(--font-sans)"
    fontSize: "var(--text-app-compact)"
  caption:
    fontFamily: "var(--font-sans)"
    fontSize: "var(--text-app-caption)"
  micro:
    fontFamily: "var(--font-sans)"
    fontSize: "var(--text-app-micro)"
  nano:
    fontFamily: "var(--font-sans)"
    fontSize: "var(--text-app-nano)"
  glyph:
    fontFamily: "var(--font-sans)"
    fontSize: "var(--text-app-glyph)"
  visualization-value:
    fontFamily: "var(--font-mono)"
    fontSize: "var(--text-app-visualization-value)"
  visualization-emphasis:
    fontFamily: "var(--font-mono)"
    fontSize: "var(--text-app-visualization-emphasis)"
  instrument-value:
    fontFamily: "var(--font-sans)"
    fontSize: "var(--text-app-instrument-value)"
  instrument-secondary:
    fontFamily: "var(--font-sans)"
    fontSize: "var(--text-app-instrument-secondary)"
  instrument-primary:
    fontFamily: "var(--font-sans)"
    fontSize: "var(--text-app-instrument-primary)"
rounded:
  sm: "6px"
  md: "8px"
components:
  button-app-primary:
    backgroundColor: "{colors.app-accent}"
    textColor: "{colors.app-on-filled}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  button-app-primary-hover:
    backgroundColor: "{colors.app-accent-hover}"
  button-app-outline:
    backgroundColor: "transparent"
    textColor: "{colors.app-text-secondary}"
    rounded: "{rounded.sm}"
  button-app-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.app-text-secondary}"
    rounded: "{rounded.sm}"
---

# Design System: RaceIQ

> The CSS contracts are the source of truth: `src/styles/theme.css` owns every theme-controlled app, status, telemetry, and visualization role, while `src/styles/branding.css` owns product, manufacturer, and team identity that must not change with the app theme. Tooling metadata references those CSS variables instead of copying their palette values.

### Imperative rendering boundary

DOM and SVG code consume theme variables directly. Main-thread renderers that require concrete browser values use `src/lib/rendering/css-values.ts`, which resolves the CSS contract with native `getComputedStyle()`. HTML Canvas drawing uses the focused proxy in `src/lib/rendering/css-canvas.ts`; uPlot, Three.js, and image export use the value bridge directly. Neither module is a Tailwind theme layer or a general color library.

The bridge is deliberately DOM-bound. `OffscreenCanvas` worker code cannot read the document theme and must receive already-resolved theme values from the main thread.

## 1. Overview

**Creative North Star: "The Cockpit Display"**

RaceIQ reads like an instrument panel, not a startup dashboard. The `app-bg`, `app-surface`, and `app-surface-alt` tokens provide the near-black tonal steps; `app-accent` marks what's live, active, or actionable, the way a dash needle catches your eye against dark bezel. Depth comes from tonal stepping between surface levels, never from drop shadows — the same physical logic as a real cockpit panel, where layers sit flush and legibility comes from contrast, not lift.

This system explicitly rejects the generic SaaS look — no gradient hero-metric tiles, no glassmorphism, no cutesy rounded card grids that could belong to any startup — and it rejects the opposite failure mode too: a raw, ungoverned sim-racing overlay (MoTeC-style) that's dense but uncalibrated and ugly. Density here is deliberate: every pixel of surface either shows a value or frames one.

**Key Characteristics:**

- Near-black base with a single cyan signal color, not a rainbow of accents
- Flat, tonally-layered surfaces — no shadows, no glass
- A semantic severity scale (`severity-nominal` → `severity-critical`) plus `operating-cold` for telemetry state encoding — never used for UI chrome
- Compact, shared type scale built for data density, with sub-11px roles reserved for constrained telemetry and visualization labels
- Tactile, confident interactive states: visible hover shifts, no timid opacity fades

## 2. Colors

A near-black instrument-panel base with one cyan accent doing all the signaling; a separate telemetry-only palette exists purely to encode data values, kept out of the interface chrome.

### Primary

- **App Accent Cyan** (`app-accent`): The only accent in the interface. Used for active states, live indicators, primary CTAs (`app-primary` button), links, and anything the driver needs to notice first. `app-accent-hover` handles hover emphasis and `app-highlight` handles emphasis without a full accent block.

### Neutral

- **App Background** (`app-bg`): The base canvas — near-black, the "cockpit bezel."
- **App Surface** (`app-surface`): Primary card/panel background, one tonal step up from the bezel.
- **App Surface Alt** (`app-surface-alt`): Nested or inset content, including input wells and secondary panels.
- **App Surface Hover** (`app-surface-hover`): Neutral interactive hover feedback. It is a state role, not another elevation level.
- **App Dropdown / App Progress Track** (`app-dropdown` / `app-progress-track`): Specialized utility surfaces that a theme may tune independently from nested content.
- **App Border / App Border Input / App Border Hover** (`app-border` / `app-border-input` / `app-border-hover`): Hairline dividers, input strokes, and neutral interactive border feedback.
- **App Text** (`app-text`): Primary reading text, near-white.
- **App Text Secondary** (`app-text-secondary`): Secondary copy, labels with real content.
- **App Text Muted** (`app-text-muted`): De-emphasized supporting text.
- **App Text Dim** (`app-text-dim`): Fine print, units, the lowest-priority readable tier.
- **App On Filled** (`app-on-filled`): Contrast text/icons placed on solid accent or status fills; it is independent of the page background.

### Telemetry Encoding Palette (data only, never UI chrome)

- **Severity scale** (`severity-nominal` → `severity-critical`): An ordered telemetry ramp for tire health, slip, brake temperature, damage, and similar measurements. Runtime code selects a semantic level, never a hue.
- **Operating Cold** (`operating-cold`): The low/cold endpoint for operating-range measurements. Optimal, caution, and critical reuse the ordered severity levels.
- **Unavailable telemetry** uses `app-text-dim`; it is absence of data, not another severity.

### UI Status Palette

- **Success / Warning / Danger / Info / Unavailable** (`status-*`): Semantic application state such as connection health, operation outcome, and unavailable data. Solid success and danger controls use their corresponding `*-hover` roles; these describe UI state and do not encode measured telemetry.

### Branding Palette

- Product, vehicle-manufacturer, and F1-team colors are editable in `src/styles/branding.css`. Components select identity with `data-game-brand`, `data-car-brand`, or `data-team-brand`; React and game adapters do not own brand color values.

### Named Rules

**The One Signal Rule.** The interface itself has exactly one accent color: cyan. If a UI element needs a second color to stand out, it's competing with the accent — fix the hierarchy, don't add a color. The telemetry severity scale exists solely to encode measured values and must never leak into buttons, nav, or chrome.

## 3. Typography

**Display/Body Font:** `var(--font-sans)` (Geist Variable by default)
**Data/Mono Font:** `var(--font-mono)` (the shared system monospace stack by default)

**Character:** A variable sans family carries interface hierarchy while the monospace role aligns telemetry values. Readable UI uses the compact 11px–18px range; smaller shared roles are reserved for dense telemetry, diagrams, and single-character glyphs. Larger visualization and instrument roles are reserved for primary driving data.

**Label Tracking:** `var(--tracking-app-label)` provides the shared wide tracking for compact uppercase labels.

### Hierarchy

- **Title** (18px / `--text-app-title`): Page and section titles.
- **Headline** (16px / `--text-app-heading`): Card headings.
- **Body** (15px / `--text-app-body`): Primary body copy and telemetry values.
- **Subtext** (14px / `--text-app-subtext`): Descriptions and secondary content.
- **Detail** (13px / `--text-app-detail`): Compact table and control content.
- **Label** (12px / `--text-app-label`): Caps labels, badges, and timestamps.
- **Compact** (11px / `--text-app-compact`): Dense controls, units, and fine print; pair with `font-mono` for telemetry values.
- **Caption** (10px / `--text-app-caption`): Dense telemetry annotations.
- **Micro** (9px / `--text-app-micro`): Compact visualization labels and badges.
- **Nano** (8px / `--text-app-nano`): Diagram labels with constrained geometry.
- **Glyph** (7px / `--text-app-glyph`): Single-character indicators only.
- **Visualization Value** (22px / `--text-app-visualization-value`): Secondary values rendered into visualization textures.
- **Visualization Emphasis** (28px / `--text-app-visualization-emphasis`): Primary values rendered into visualization textures.
- **Instrument Value** (40px / `--text-app-instrument-value`): Fixed-size cockpit readouts.
- **Instrument Secondary** (`clamp(40px, 13vh, 112px)` / `--text-app-instrument-secondary`): Responsive speed and lap readouts.
- **Instrument Primary** (`clamp(48px, 14vh, 128px)` / `--text-app-instrument-primary`): Responsive primary gear readout.

### Named Rules

**The Compact Scale Rule.** Use the shared `text-app-*` roles instead of one-off pixel sizes. Caption, micro, nano, and glyph are for constrained telemetry or visualization contexts, not general body copy. Sizes above 18px are limited to Tailwind's shared display scale and the explicit visualization or instrument roles; do not invent component-local display sizes.

## 4. Elevation

RaceIQ is flat by design. Depth is conveyed entirely through tonal layering: background → surface → surface-alt, each one step lighter. A panel doesn't lift off the page; it sits on a shelf one shade brighter than what's behind it.

### Named Rules

**The Flat-By-Default Rule.** No drop shadows, no glassmorphism, no blur. If a component needs to read as "above" another, move it one step up the surface ramp (bg → surface → surface-alt); don't reach for a shadow.

## 5. Components

Tactile and confident: interactive elements shift color decisively on hover/active rather than fading, and default sizing stays compact and utilitarian to fit dense telemetry layouts.

### Buttons

- **Shape:** Small rounded corners (6-8px, `rounded-sm`/`rounded` via `--radius-md`), consistent across all app-* variants.
- **Primary (`app-primary`):** Solid `app-accent` background with `app-on-filled` contrast text; hover moves to `app-accent-hover`, while disabled uses a reduced-strength accent.
- **Outline (`app-outline`):** Transparent background, `app-border-input` stroke, and secondary text; neutral hover feedback uses `app-border-hover`.
- **Ghost (`app-ghost`):** Transparent, no border, text-only with the same secondary-to-full-text hover shift.
- **Danger (`app-danger`):** Solid `status-danger` with `app-on-filled` contrast text, reserved for destructive actions only.
- **Sizing:** Compact, padding-driven (`app-sm` 8px/2px, `app-md` 12px/6px, `app-lg` 16px/8px) rather than fixed heights — built to sit inline in dense header/toolbar rows.
- **Active state:** `translate-y-px` on press — a physical "button depressed" micro-shift instead of an opacity or color change.

### Cards / Containers

- **Corner Style:** Same compact radius as buttons (6-8px).
- **Background:** `app-surface`, stepping to `app-surface-alt` for nested or inset panels; interactive cards use `app-surface-hover` only while hovered.
- **Shadow Strategy:** None — see Elevation. Separation comes from the structural surface step and the hairline `app-border`.
- **Border:** 1px `app-border`; inputs use `app-border-input`, while neutral interactive feedback uses `app-border-hover`.
- **Dashboard widgets:** Period stat cards, standalone insight panels, and the activity calendar use the same 1px `app-border` outline. Clean laps and Consistency are separate widgets; each owns its border, surface, and padding. Nested metrics remain unboxed.
- **Gradient variant:** Only overview game cards use shared `Card variant="gradient"`: `app-bg` with a subtle 12% `app-accent` radial gradient at the top right, hairline border, and no blur or shadow. Non-game dashboard cards use flat surfaces.
- **Latest Session:** Retain the reference-led cyan best-lap border, purple timing display, and widely tracked monospace labels on a flat dashboard surface. `theme.css` owns the `--recap-*` accent palette; `SessionRecap.css` scopes the typography and timing accents to this surface. Keep the dashboard card half-width on desktop and full-width on narrow workspaces. Place genuine catalogue car artwork in the upper-right and actual track outline beside prominent track identity on the left, then a best-lap panel beside three sector panels and a bordered stats footer. No driver identity, Discord elements, RaceIQ logo, or promotional slogans inside the card. Show valid/total laps, distance, time on track, and full session type; retain race classification. The entire loaded card is a session-analysis link to `/analyse`, with visible keyboard focus and native new-tab behavior; navigation does not require a valid best lap. No separate Analyse Session button. Place the weather icon in the former footer action slot: right of stats on desktop, below them on narrow cards. Use recorded conditions from the best lap, or first lap when no best lap exists; never assume clear weather when conditions are missing. Unknown weather uses the labelled unavailable icon. Keep NEW PB in the card header's top-right, separate from car/track identity. Omit unavailable artwork or geometry. Purple best-lap typography is aesthetic, not evidence of a PB; PB badges require `personalBest.isNew`, and PB deltas compare with the previous lap record. Sector deltas compare the displayed best-lap sector with its previous all-time best and are omitted without that evidence. No bars beneath sector times. Purple sector numbers still require the displayed sector to match the fastest time for that same sector in the session.
- **Latest Session density and background:** Preserve the compact footprint: an 80px minimum identity header, smaller responsive timing text, tight timing-panel spacing, and inline desktop footer rather than a tall hero. Latest Session and Favourite track/car use the same flat `app-surface-alt/30` background and `app-border` outline as dashboard insight panels, with no outer shadow. Timing, footer, and favourite statistics panels have transparent backgrounds; retain their borders without inset shading. Reference-specific glow remains confined to best-lap and PB accents. Outer radius is 12px; timing and footer panels use 8px.
- **Latest Session type scale:** Use the 16px `app-heading` token for track identity, fluid 20–24px best-lap text, and 14px sector values stepping to the 16px `app-heading` token on extra-wide cards. Preserve readable labels and metadata; this compact scale does not change standalone session recaps.
- **Latest Session rain:** Show the recorded rain percentage beside the footer weather icon with the existing localized Rain label. Keep `0%` visible; omit the percentage when no recorded value is available.
- **Race recap results:** Show finishing position only for race or sprint sessions. Explicit DNF or retired classification takes precedence over a recorded position; missing result evidence remains unavailable rather than implying a non-finish.

### Inputs / Fields

- **Style:** `app-surface-alt` background, 1px `app-border-input` stroke, matching button radius.
- **Focus:** Border brightens; no glow or ring beyond the shadcn-token `ring` variants used on the base `Input` component.

### Navigation

- **Style:** Dark chrome matching `app-surface`, active/current item marked with the cyan accent (text or underline), not a background fill — keeps the One Signal Rule intact even in nav.
- **Default tabs and scope selectors:** Use Sessions' compact bordered segmented treatment: `app-bg`, shared outer border, contiguous 30px controls, and accent text plus an accent outline for the selected item, not an accent fill. Dashboard periods reuse Sessions' `ToggleGroup03`; content tabs retain tab semantics. Explicit pills and underline variants remain available.

## 6. Do's and Don'ts

### Do:

- **Do** keep `app-accent` as the only interface accent — telemetry data can use the semantic severity scale, chrome cannot.
- **Do** convey elevation with the bg → surface → surface-alt tonal steps, never a shadow.
- **Do** use the shared `text-app-*` scale; this is a cockpit, not a marketing page.
- **Do** use the `translate-y-px` active-press shift on interactive elements to keep the "tactile and confident" feel.
- **Do** pack real data into every surface — density is the point, not a flaw to soften.

### Don't:

- **Don't** use gradient hero-metric tiles, glassmorphism, or cutesy rounded card grids — the generic SaaS look this system explicitly rejects.
- **Don't** let the raw sim-racing-overlay failure mode in either — dense is fine, uncalibrated and ugly is not.
- **Don't** add decorative `box-shadow`; use the tonal surface scale for elevation.
- **Don't** use telemetry severity colors on buttons, nav, or any UI chrome — they're reserved for measured values only.
- **Don't** introduce a second accent color to solve a hierarchy problem — fix the hierarchy instead.
