# Task 4: Migrate select/menu consumers and complete audit

## Completed
- Migrated Motec import DialogTitle typography to shared `DialogTitle variant="import"`, matching repeated import-title treatment.
- Added shared `form-section` Card, `form-section-toggle` Button, and `form-section-empty` Badge variants; removed FillForm Card/Button/Badge appearance overrides while retaining field and section layout classes.
- Retained SetupFilePicker DialogContent sizing and flex/scroll classes as composition-only requirements for its viewport-constrained, scrollable picker; documented rationale inline. Removed description typography override.
- Removed assistant thread Button/TooltipIconButton appearance overrides, preserving only positioning, responsive/layout, and semantic component props. Shared Button/Tooltip primitives own interaction/focus treatment.
- Removed tool-fallback approval `active:scale` consumer class; shared Button owns press feedback.
- Verified SearchSelect and DropdownMenu internals remain primitive-owned for trigger/menu surfaces, spacing, borders, focus, and item states. SearchSelect retains responsive typography and app-accent focus treatment from f09ec40b.
- Screenshot assets were not touched.

## Verification
- `cd client && bun run build`: PASS.
- `cd client && bun run build-storybook`: PASS.
- `cd client && bun run snapshot:test -- src/stories/dashboards.snapshot.ts`: BLOCKED: `http://localhost:6006/index.json is already used`.
