
## Atomic Replacement Fix
- Candidate stored evidence and transform now build off-map; existing calibration remains intact when replacement input fails validation or has insufficient bins.
- Added regression test for failed replacement preservation.
- Commit: `5abdcc833`.
- Focused test: 5 pass, 0 fail.
