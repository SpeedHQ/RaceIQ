# Task 3 — Shared Tabs primitive and migration report

## Scope

Added typed wrappers around Base UI Tabs (`Tabs`, `TabsList`, `TabsTrigger`, and `TabsContent`) with string-valued tabs, shared active/inactive/focus/disabled styling, and app border treatment.

Migrated manual tab strips in:

- `components/setup-tune/FillForm.tsx` — preserved `TAB_DEFS`, `Other` fallback, section grouping, active-data dots, and active panel content while moving keyboard/state behavior to Base UI Tabs.
- `components/ai/analysis-summary.tsx` — preserved localized labels, badges/flags, subtitle, single-title fallback, and externally synchronized active tab state.
- `components/tunes/SetupFilePicker.tsx` — preserved dynamic tab ordering, corner/section partitioning, empty/loading behavior, and per-tab layout content.

Added Storybook coverage for uncontrolled tabs (including disabled trigger and ArrowRight keyboard navigation) and controlled tabs (`value`/`onValueChange`).

## Behavior preservation

- Tab values use stable labels and remain controlled where existing caller state owns selection.
- Base UI tab semantics replace manual `role="tablist"`, `role="tab"`, `aria-selected`, and click-only selection.
- Existing compact app typography, accent active state, muted inactive state, focus ring, disabled state, and border-bottom treatment remain represented in shared styling.
- Setup and analysis tab content remains localized and structurally unchanged.

## Verification

Per shared parallel-task instruction, no build, test, Storybook, lint, or formatter command was run in this worktree.

## Shared story follow-up

Added `BadgeVariants` coverage requested by the controls slice: all semantic variants, compact/default sizes, long-text wrapping, and a decorative `aria-hidden` badge without focus semantics.
