# Dashboard widget borders

ADR: [Widget boundary treatment](../adr/0008-dashboard-widget-borders.md)

## Scope

Apply consistent 1px neutral `app-border` outlines to standalone dashboard widgets: period stats, insight panels, and activity calendar. Preserve existing game-card and session-card borders. Clean laps and Consistency must be separate widgets with their own outlines; nested metrics remain unboxed. Preserve content, surface colors, and interactions.

## Implementation and acceptance

Add `border border-app-border` to the existing widget shells; retain compact corner radii. Place Consistency in its own shell below Clean laps in the first desktop column and immediately after it on mobile. Verify the actual dashboard at desktop and mobile widths, checking separate boundaries, computed border styles, tooltip interaction, and overflow. No shared Card API changes or unrelated restyling.
