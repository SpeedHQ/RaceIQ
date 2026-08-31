
## Malformed Stored Position Fix
- Filter non-finite and zero positions before spatial downsampling, preventing malformed first samples from poisoning valid evidence.
- Added mixed malformed/valid regression.
- Commit: `ed2159230`.
- Focused test: 6 pass, 0 fail.
