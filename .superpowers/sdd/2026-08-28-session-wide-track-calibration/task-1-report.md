
## Follow-up Fix
- Validate outline coordinates and nonzero arc length before live state creation.
- Route stored-position calibration through same 100-bin sampler, preventing unbounded state and keeping `samplesByBin` consistent.
- Commit: `91d5a01c8`.
- Focused test: 4 pass, 0 fail.
