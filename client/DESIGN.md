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
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "1.125rem"
  heading:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "1rem"
  body:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "0.9375rem"
  subtext:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "0.875rem"
  label:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "0.75rem"
  unit:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "0.6875rem"
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

## 1. Overview

**Creative North Star: "The Cockpit Display"**

RaceIQ reads like an instrument panel, not a startup dashboard. The `app-bg`, `app-surface`, and `app-surface-alt` tokens provide the near-black tonal steps; `app-accent` marks what's live, active, or actionable, the way a dash needle catches your eye against dark bezel. Depth comes from tonal stepping between surface levels, never from drop shadows — the same physical logic as a real cockpit panel, where layers sit flush and legibility comes from contrast, not lift.

This system explicitly rejects the generic SaaS look — no gradient hero-metric tiles, no glassmorphism, no cutesy rounded card grids that could belong to any startup — and it rejects the opposite failure mode too: a raw, ungoverned sim-racing overlay (MoTeC-style) that's dense but uncalibrated and ugly. Density here is deliberate: every pixel of surface either shows a value or frames one.

**Key Characteristics:**
- Near-black base with a single cyan signal color, not a rainbow of accents
- Flat, tonally-layered surfaces — no shadows, no glass
- A semantic severity scale (`severity-nominal` → `severity-critical`) plus `operating-cold` for telemetry state encoding — never used for UI chrome
- Compact, utilitarian type scale (11px–18px) built for data density
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

**Display Font:** Geist Variable, sans-serif
**Body Font:** Geist Variable, sans-serif
**Label/Mono Font:** Geist Variable (same family; no separate mono in use)

**Character:** One variable sans family carries the entire hierarchy through weight and a tight, compact size scale (11px–18px) — legible at a glance, built for data density rather than editorial breathing room.

### Hierarchy
- **Title** (18px / `--app-font-title`): Page and section titles.
- **Headline** (16px / `--app-font-heading`): Card headings.
- **Body** (15px / `--app-font-body`): Primary body copy and telemetry values.
- **Subtext** (14px / `--app-font-subtext`): Descriptions, secondary content.
- **Label** (12px / `--app-font-label`): Caps labels, badges, timestamps.
- **Unit** (11px / `--app-font-unit`): Units and fine print — the smallest legible tier, used only for unit suffixes (mph, °C, psi).

### Named Rules
**The Compact Scale Rule.** Every size step is smaller than a typical marketing scale — this is a cockpit, not a landing page. Never introduce a size above 18px (`--app-font-title`) outside a genuinely new page-level heading need.

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

### Inputs / Fields
- **Style:** `app-surface-alt` background, 1px `app-border-input` stroke, matching button radius.
- **Focus:** Border brightens; no glow or ring beyond the shadcn-token `ring` variants used on the base `Input` component.

### Navigation
- **Style:** Dark chrome matching `app-surface`, active/current item marked with the cyan accent (text or underline), not a background fill — keeps the One Signal Rule intact even in nav.

## 6. Do's and Don'ts

### Do:
- **Do** keep `app-accent` as the only interface accent — telemetry data can use the semantic severity scale, chrome cannot.
- **Do** convey elevation with the bg → surface → surface-alt tonal steps, never a shadow.
- **Do** keep the type scale within 11px–18px; this is a cockpit, not a marketing page.
- **Do** use the `translate-y-px` active-press shift on interactive elements to keep the "tactile and confident" feel.
- **Do** pack real data into every surface — density is the point, not a flaw to soften.

### Don't:
- **Don't** use gradient hero-metric tiles, glassmorphism, or cutesy rounded card grids — the generic SaaS look this system explicitly rejects.
- **Don't** let the raw sim-racing-overlay failure mode in either — dense is fine, uncalibrated and ugly is not.
- **Don't** add decorative `box-shadow`; use the tonal surface scale for elevation.
- **Don't** use telemetry severity colors on buttons, nav, or any UI chrome — they're reserved for measured values only.
- **Don't** introduce a second accent color to solve a hierarchy problem — fix the hierarchy instead.
