# Compare Transparent Cards Design

## Goal

Make all compare-page cards visually transparent instead of gray while preserving their existing borders, corner radii, spacing, and content.

## Scope

Update card wrappers in `client/src/components/comparison/CompareAiPanel.tsx`:

- Inputs comparison card
- Per-lap analysis cards
- Segment analysis cards
- Coaching tip cards

Remove only their `bg-app-surface-alt/*` background utility classes. Keep each existing `border` utility unchanged. No changes to the compare track map, AI sidebar, buttons, typography, layout, or behavior.

## Alternatives considered

1. Remove background utilities directly from each compare card. Recommended: smallest change and preserves existing styling contracts.
2. Introduce a shared transparent-card class. Unnecessary abstraction for one focused visual adjustment.
3. Change border opacity while removing backgrounds. Rejected because request explicitly preserves borders and this would alter contrast.

## Verification

Confirm source contains no gray background utility on compare card wrappers and existing border utilities remain. Run the focused client type/build or lint check used by this repository for changed UI code.
