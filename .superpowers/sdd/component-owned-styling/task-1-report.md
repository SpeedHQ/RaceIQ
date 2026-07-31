# Task 1 Report: Semantic variant contracts

## Inventory
Reviewed PR #198-touched consumer patterns for repeated Button app actions, menu actions, close controls, destructive outlines, selected toggles, full-width actions; Badge catalog/game-brand/AI status treatments; repeated Card settings/transparent/tune shells; tabs and table shells. Existing consumer files were not modified in this task.

## Implementation
- Added Button semantic variants: `menu-action`, `close-action`, `destructive-outline`, `selected-toggle`, `full-width-action`.
- Added Badge semantic variants: `catalog-category`, `game-brand`, `ai-status`; existing status variants and sizes preserved.
- Added Card variants: `settings-section`, `transparent-panel`, `tune-summary`, with `data-variant` contract.
- Added Dialog `layout` typed contract while preserving existing size variants and close behavior.
- Added Tabs list/trigger typed semantic variants (`default`, `settings`, `pills`) while preserving controlled/uncontrolled Base UI behavior and state styling.
- Added typed Table `variant` (`default`, `settings`) and data attribute without changing table behavior.
- Added Storybook `SemanticVariants` story with assertions for semantic controls, default button type, and badge rendering.

## Verification
Command: `cd client && bun run build-storybook`
Outcome: passed; Storybook static build completed successfully. Initial run exposed malformed Badge config syntax; corrected and reran successfully. No project-wide tests, formatters, or linters run per brief.

## Scope protection
No screenshot assets or screenshot snapshots were included in commit scope.

## Commit
`feat(ui): add semantic component variants`
