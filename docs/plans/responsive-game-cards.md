# Responsive dashboard game cards

## Requirements

Adapt the selected dashboard `GameBrandCards` section to mobile, tablet, and desktop workspace widths. Reduce card size and remove unnecessary empty space. Preserve all six game names, logos, brand colors, routes, lap/time values, and hidden-game filtering. Avoid clipped titles, squeezed metrics, and horizontal overflow; keep keyboard navigation usable. Do not redesign unrelated dashboard sections.

## Implementation

Replace the two-column-to-flex layout with a workspace-container grid: one column on narrow phones, two from 384px, three from 768px, and six from 1024px. Use equal-width shrinkable tracks, wrapping full titles, 10px padding, 24px logo containers, and inline label/value metrics. Remove reserved header height and hover scaling; preserve visible keyboard focus. Retain existing branding and translated metric labels without new dependencies.

## Verification

Inspect actual browser rendering at 320, 390, 768, 1024, 1280, and 1600px widths; assert card/title/metric bounds and route destinations. Exercise keyboard focus and game navigation. Run focused lint and the design detector. Real-device testing is outside available browser verification.

## Decision record

[Responsive game-card grid](../adr/0002-responsive-game-cards.md)
