# Overview typography

ADR: [Compact overview typography](../adr/0004-overview-typography.md)

## Requirements

Remove oversized metrics and inconsistent text sizing on global and per-game Overview. Preserve font families, layout, content, data calculations, controls, responsive behavior, and non-Overview surfaces.

## Implementation

Use existing shared roles: 18px page title, 14px section headings, 16px numeric metrics, 12px labels, 13px supporting text. Game-card lap/time values use 13px normal weight to keep them subordinate to logos, per updated user feedback. Other metrics use semibold; retain monospace/tabular numerals for measurements. Add an optional compact recap presentation for Overview, keeping standalone recap unchanged. Keep small heatmap annotations constrained to the visualization.

## Acceptance and verification

Inspect populated Overview in browser before and after. Verify computed metric sizes and desktop/phone screenshots, period switching, game navigation, narrow-width wrapping, and 200% zoom. Run changed-file lint, frontend typecheck, and UI detector. Document user-visible change in changelog.
