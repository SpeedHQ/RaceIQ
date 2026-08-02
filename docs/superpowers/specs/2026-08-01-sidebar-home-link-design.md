# Sidebar Home Link and Collapse Alignment

## Scope

Update RaceIQ navigation headers in `client/src/components/AppSidebar.tsx` and the mobile shell in `client/src/routes/__root.tsx`.

## Behavior

- Desktop expanded sidebar: `RaceIQ` is a TanStack Router link to `/`.
- Desktop expanded sidebar: collapse control stays aligned to the right edge of the header.
- Desktop collapsed sidebar: title remains visually hidden and collapse control remains centered.
- Mobile header: `RaceIQ` is a TanStack Router link to `/`; navigation close control remains right aligned.
- Existing close callbacks, collapse state, labels, and route behavior remain unchanged.

## Implementation

Use existing `Link` and button primitives. Preserve current header height, borders, colors, typography, and responsive classes. Use a flex spacer/alignment pattern rather than absolute positioning.

## Verification

Build the client and smoke-test desktop expanded/collapsed states plus mobile navigation: activating either RaceIQ title navigates home, and collapse/close controls remain at the right edge when titles are visible.
