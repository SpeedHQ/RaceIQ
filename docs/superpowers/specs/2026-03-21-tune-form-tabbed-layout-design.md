# Tune Form: Tabbed Full-Page Layout

**Date:** 2026-03-21
**Status:** Approved

## Summary

Replace the current vertical accordion form (`TuneForm`) with a 2-tab full-page layout. The collapsible `SettingsSection` accordion pattern is removed in favor of always-visible card grids.

## Layout

### Page structure

```
┌─────────────────────────────────────────────────┐
│  ← Create New Tune          [Cancel] [Save Tune] │  ← sticky, opaque bg
├─────────────────────────────────────────────────┤
│  Info  │  Settings                               │
├─────────────────────────────────────────────────┤
│  (tab content scrolls)                          │
└─────────────────────────────────────────────────┘
```

- The back arrow + title + action buttons are a sticky header **inside** the scrolling container (the route wrapper uses `overflow-auto`, so sticky children work correctly)
- Sticky header uses an opaque background matching the app surface (`bg-app-bg` or `bg-app-surface`) with appropriate `z-index`
- Two tabs: **Info** and **Settings**, implemented using the existing shadcn `<Tabs>` component from `client/src/components/ui/tabs`
- Full-width layout (remove the `max-w-xl mx-auto` constraint on the route wrappers)

### Info tab

Fields in a 2-column grid:
- Tune Name (full width)
- Author (half) | Car search/dropdown (half)
- Category select — all 5 values from `ALL_CATEGORIES` (half) | Description (half, or full width)

No unit system toggle on this tab.

### Settings tab

- Header row: "Tune Parameters" label | JSON Import button | **Metric/Imperial toggle** (single, canonical location)
- The `isMetric` state remains local to `TuneForm` — the toggle on this tab is the only toggle
- All 11 setting sections rendered as always-visible cards in a responsive grid: `grid-cols-1 md:grid-cols-2`
- Each card: section title in accent color, fields as label+input rows using `NumberField`
- Cards: Tires, Gearing, Alignment, Anti-Roll Bars, Springs, Damping, Roll Center Height, Anti-Geometry, Aero, Differential, Brakes

## Changes

### `client/src/components/TuneForm.tsx`

- Remove `openSections` / `toggleSection` state (no longer needed)
- Delete `SettingsSection` component (only used inside `TuneForm`; no external consumers)
- Add `activeTab: "info" | "settings"` state, defaulting to `"info"`
- Replace the single-column form JSX with shadcn `<Tabs>` wrapping two `<TabsContent>` panels
- Unit system toggle moves to the Settings tab header only

### `client/src/routes/tunes/new.tsx`

- Remove `max-w-xl mx-auto` width constraint

### `client/src/routes/tunes/edit.$tuneId.tsx`

- Remove `max-w-xl mx-auto` width constraint (same pattern)

## What does NOT change

- All form state, validation, JSON import, unit conversion logic unchanged
- `TuneSettingsPanel` (read-only view) unchanged
- `UserTuneCard` unchanged
- `NumberField`, unit helpers (`toDisplay`, `fromDisplay`, `unitLabel`), constants unchanged
