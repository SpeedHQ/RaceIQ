# Task 7 Report: Align Select and Menu Overlay Primitives

## Scope

Updated owned overlay files:

- `client/src/components/ui/SearchSelect.tsx`
- `client/src/components/ui/SearchMultiSelect.tsx`
- `client/src/components/ui/DropdownMenu.tsx`
- `client/src/components/analyse/AnalyseLapHeader.tsx`

`SetupFilePicker.tsx` and Storybook files were not touched because they are outside this worktree's owned scope.

## Overlay behavior map

- `SearchSelect`: single selection, free-text filtering, grouped options, disabled options, keyboard navigation, portal rendering, viewport-aware placement, and focus return.
- `SearchMultiSelect`: multi- or single-selection state supplied by callers, custom search keys, custom item rendering, keyboard navigation, portal rendering, and optional clear action.
- `DropdownMenu`: action-menu semantics delegated to Base UI Menu, including keyboard handling, focus management, disabled items, portal rendering, collision positioning, and close behavior.
- `AnalyseLapHeader`: track, car, lap, and tune selectors use the shared searchable selector; export/import actions use the shared menu.

## Changes

- Standardized overlay surface and item styling around app border/surface/text/accent tokens.
- Added stable combobox/listbox IDs and selection/highlight ARIA state to searchable selectors.
- Added highlighted-item keyboard navigation, Home/End support, disabled-option skipping, and viewport-aware portal placement for `SearchSelect`.
- Added highlighted-item keyboard navigation and portal collision-aware placement for `SearchMultiSelect` while preserving custom filtering, renderers, and selection modes.
- Replaced custom `DropdownMenu` portal/event positioning with Base UI Menu primitives and mapped left/right alignment to Base UI start/end alignment.
- Migrated the tune selector in `AnalyseLapHeader` from native `<select>` to `SearchSelect` without changing tune callbacks, labels, pending state, or view action.

## Verification

Validation commands were intentionally not run per assignment instruction.
