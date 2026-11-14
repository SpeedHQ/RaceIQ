# Race result position contract

This contract separates F1 grid position from qualifying classification.

## Shared behavior

- `gridPosition` means car's starting grid slot. F1 `FinalClassificationData.gridPosition` and `LapData.gridPosition` provide this value.
- `qualifyingPosition` means classified result from a qualifying session. F1 UDP fields used by RaceIQ do not provide this ranking for a race session, so RaceIQ leaves it unavailable rather than copying grid position.
- Persist, return, and display these fields independently.
- Race timeline shows `Qualified` only when qualifying position evidence exists. It shows `Start` from grid position. Position-change direction starts from grid position when available.
- Historical F1 rows currently store `gridPosition` in `qualifying_position`. Migration moves those values to `grid_position`, clears the false qualifying value, and marks rows for reconciliation.

## Backend plan

- Add `gridPosition` to shared result, source, and derived contracts.
- Read F1 grid position into `gridPosition`; leave F1 `qualifyingPosition` unavailable.
- Add `grid_position` storage and API output; migrate historical F1 values and stale processor versions.
- Acceptance: source/derive tests distinguish grid position from qualifying position; storage test verifies round-trip and migration.

## UI plan

- Render qualifying and starting grid positions from their own fields.
- Keep result summary wording truthful when qualifying rank is absent.
- Acceptance: ledger test proves grid P1 renders as start P1 without a qualifying node, while a supplied qualifying P3 remains a separate qualifying node.

UI depends on backend contract above; both plans implement this document's shared API and persistence behavior.
