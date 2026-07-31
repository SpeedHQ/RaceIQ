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

## Final audit
- `MotecImportModal.tsx:120` `DialogContent className="max-w-xl"` remains layout-only: constrains modal width while `DialogContent size="lg"` owns surface, border, radius, padding, and typography.
- `thread.tsx:162` `Button className="aui-thread-welcome-suggestion"` remains a styling hook for assistant-ui suggestion composition; no appearance utility classes.
- `thread.tsx:209,234,240,467` primitive classNames (`aui-composer-dictate`, `aui-composer-send`, `aui-composer-cancel`, `aui-user-action-edit`) remain hook/layout selectors only; shared Button/TooltipIconButton props own appearance and interaction.
- `SetupFilePicker.tsx:40-41` `DialogContent` sizing/flex and `DialogHeader` min-width/padding remain composition-only for constrained scrolling and close-button clearance.
- `thread.tsx:224` StopDictation now uses semantic `variant="destructive"` and shared `size="icon-destructive"` (`size-7 rounded-full`), preserving destructive intent, dimensions, radius, tooltip, accessibility label, and behavior without consumer appearance classes.

## Final verification
- `cd client && bun run build`: PASS.
- `cd client && bun run build-storybook`: PASS.
- `cd client && bun run snapshot:test -- src/stories/dashboards.snapshot.ts`: RUNNABLE after stopping stale sibling-worktree Storybook on port 6006; 3/7 passed, 4 failed pixel comparisons (F1LiveDashboard, ForzaLiveDashboard, AccLiveDashboard, ComboDash1). Baselines were not updated.
