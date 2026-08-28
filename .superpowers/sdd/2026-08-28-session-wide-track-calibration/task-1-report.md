
## Stored Import Replacement Fix
- `calibrateFromPositions` now resets prior live/stored evidence before feeding imported positions, so repeated imports cannot retain stale bins or ignore new data.
- Commit: `e5f13e826`.
- Focused test: 4 pass, 0 fail.
