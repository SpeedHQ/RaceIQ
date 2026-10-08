# Responsive dashboard game cards

## Requirements

Adapt Overview's top `GameBrandCards` to mobile, tablet, and desktop workspace widths. Use logos alone for visible game identity. Reduce card width to fit more per row; center all rows, including incomplete rows. Keep lap/time to the right of the logo; right-align both values and labels, placing labels after values. Rename Time to Driving using existing translated copy. Add a shared `Card` gradient variant matching Latest Session and use it for both surfaces. Preserve regular-weight text, accessible game names, all six logos, routes, lap/time values, and hidden-game filtering. Avoid clipping and horizontal overflow; keep keyboard navigation usable. Do not redesign unrelated dashboard sections.

## Implementation

Use centered wrapping flex rows with content-sized cards at least 168px wide, replacing the expanding fixed-column grid. Each card uses 8px padding and a 56px-high logo area, with right-aligned values and trailing labels in two shared grid columns right. Reuse translated Driving copy. Add `variant="gradient"` to shared Card with a subtle theme-accent radial gradient from top right, border, and no shadow. Wrap game content in Card inside its existing Link; migrate both Latest Session shells to this variant, removing duplicated blurred glow elements and obsolete game-card CSS. Keep 13px monospace values at normal weight, accessible names, routes and focus behavior. Other Card variants remain unchanged.

### Official logo colours

Render all six Overview card logos as original-colour image assets without recolouring filters. Preserve the bundled ACC, AC Evo, iRacing, and Le Mans Ultimate artwork colours; give the monochrome F1 and Forza assets intrinsic official red and white respectively. Scale logos proportionally within the card's inset area, behind the metrics, and apply a horizontal alpha fade toward the right-hand text. Reserve sufficient height and left-side space so wide wordmarks are recognisable rather than constrained to 40×24px. Keep metrics, accessible names, routes, and hidden-game filtering unchanged. Leave sidebar and per-game header treatments unchanged. Verify every image loads, preserves aspect ratio and colours, and fades without obscuring metrics on desktop and mobile.

## Verification

Inspect actual browser rendering at 320, 390, 768, 1024, 1280, and 1600px widths; assert card/title/metric bounds and route destinations. Exercise keyboard focus and game navigation. Run focused lint and the design detector. Real-device testing is outside available browser verification.

## Decision record

[Responsive game-card grid](../adr/0002-responsive-game-cards.md)
