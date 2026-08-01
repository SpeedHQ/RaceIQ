# Task 6 — Shared table primitives and migration report

## Scope

Extended `client/src/components/ui/AppTable.tsx` with native table/section/row props, `cn` class composition, per-table class overrides, optional header-row classes, and shadcn-style aliases: `TableHeader`, `TableBody`, `TableRow`, `TableHead`, and `TableCell`. Existing `Table`, `THead`, `TBody`, `TRow`, `TH`, and `TD` exports remain compatible.

Migrated owned standard table views:

- `ChatsPage.tsx`: responsive chat history table now uses shared table composition; localized labels, action handlers, empty state, and responsive overflow remain unchanged.
- `f1/F1GridTable.tsx`: bounded scrolling grid table now uses shared composition; sticky header, tire indicators, localized labels, and row rendering remain unchanged.
- `f1/F1LiveDashboard.tsx`: live standings table now uses shared composition; bounded scrolling, sticky header, focused/separator rows, highlight state, and standings toggle remain unchanged.
- `analyse/WheelTable.tsx`: compact analysis wheel table now uses shared composition while preserving its fixed column layout, optional headers, border-top mode, span-two-cell rows, and compact spacing.

## Raw-table inventory and exclusions

Raw tables found during mapping included `CarsPage.tsx`, `ChatsPage.tsx`, `CornerTable.tsx`, `LapList.tsx`, `analyse/WheelTable.tsx`, `comparison/CompareTrackMap.tsx`, F1 tables, setup/tune tables, and track-focus tables. This slice migrated only owned files. `TrackDetail.tsx` and `CarsPage.tsx` are explicitly owned by final integration/controls work; other feature tables remain outside this task's ownership. Canvas/virtualized table-like surfaces were not changed.

## Verification

Per shared task contract, no build, test, Storybook, lint, or formatter command was run in this worktree. `git diff --check` completed without reported whitespace errors.
