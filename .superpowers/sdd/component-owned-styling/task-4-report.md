# Task 4: Select/menu consumers and styling audit

## Changes
- Added semantic `search-select-trigger` and `search-select-clear` Button variants to own recurring trigger dimensions, border, typography, spacing, and states.
- Migrated `SearchMultiSelect` trigger and clear controls from native appearance-heavy buttons to shared `Button` API. Preserved all ARIA attributes, selection behavior, responsive sizing, and localization.
- Audited listed consumers and PR #198 touched files. Remaining consumer `className` values are layout/composition-only or component-specific assistant presentation wrappers; no screenshot assets touched.

## Verification
- `cd client && bun run build` — passed.
- `cd client && bun run build-storybook` — passed.
- `cd client && bun run snapshot:test -- src/stories/dashboards.snapshot.ts` — blocked: localhost:6006 already in use; Playwright refused server startup.

## Concerns
- Snapshot check requires existing Storybook process on port 6006 to be stopped or configured for reuse.
