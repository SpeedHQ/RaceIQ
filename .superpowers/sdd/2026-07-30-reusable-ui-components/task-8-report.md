# Task 8 report: final reusable UI audit

## Completed migrations

- Replaced deferred common controls with shared primitives:
  - `ai/analysis-summary.tsx`: shared `Button`, semantic `Badge`, and dialog title semantics.
  - `setup-tune/FillForm.tsx`: shared `Button`, `Badge`, and `Card` for section shells; existing shared tabs retained.
  - `tunes/SetupFilePicker.tsx`: shared refresh `Button`; existing `Dialog`, `Tabs`, and `SearchSelect` composition retained, including cascading picker behavior.
  - `tunes/ExperimentList.tsx`: shared `Button`, `Badge`, `Card`, `Table` layer, and `Dialog` for both new-experiment flows. Drag/drop, notices, searchable pickers, placement, Escape/backdrop close, and localized state text remain in callers.
- Migrated remaining standard table surfaces:
  - `CarsPage.tsx` comparison table and car-detail overlay now use shared table/dialog primitives.
  - `track/TrackDetail.tsx` empty-state row now uses shared table helpers; main lap table was already on `AppTable`.
  - `tunes/tune-version-shared.tsx`, `CornerTable.tsx`, and `LapList.tsx` now use the shared `Table` wrapper while retaining feature-specific sorting and cell behavior.
- Removed the obsolete `createPortal` modal shells from `ExperimentList.tsx` and dead shell markup from migrated surfaces.

## Audit classification

Remaining raw table markup is intentional:

- `assistant-ui/markdown-text.tsx`: renderer output for assistant-authored Markdown tables; not an app table callsite.
- `comparison/CompareTrackMap.tsx`: compact telemetry/map segment readout with feature-specific density.
- `f1/F125TrackSetups.tsx`: setup-tip detail rows embedded in a domain-specific setup browser.
- `tunes/track-focus/{CornerLedger,SectorHeatmap,SectorLedger}.tsx`: telemetry visualization tables with bespoke metrics and sticky/heatmap presentation.
- `ui/AppTable.tsx`: shared primitive implementation.

Remaining rounded dots, switches, progress bars, and chart/telemetry markers are not status-pill or common-action contracts and remain domain-specific.

## Verification

Per task instruction, no explicit tests, builds, Storybook, linters, or formatters were run. Structural source inspection and targeted markup searches were used for the audit. The commit hook ran its automatic lint/typecheck checks and blocked the first commit attempt: it reported formatting/import diagnostics in touched files plus pre-existing syntax errors in `SessionsPage.tsx`, `comparison/CompareTrackMap.tsx`, and `tune/TuneFormDialog.tsx`; no hook fixes were applied.

## JSX structure repair

- Restored the selected-items conditional wrapper around the shared delete `Button` in `SessionsPage.tsx`.
- Restored `filteredFormCars.map` callback structure, JSON parse error rendering, and sticky footer wrapper in `tune/TuneFormDialog.tsx` without changing shared `Button` conversions.
- Restored the `segments.length > 0 ? (...) : null` closing expression before the shared `Card` in `comparison/CompareTrackMap.tsx`.
- No tests, builds, linters, or formatters run per fixer assignment; inspected resulting snippets and exact diff for balanced JSX structure.
