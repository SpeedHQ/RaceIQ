# Settings test cleanup

- Updated `test/runtime/settings.test.ts` to snapshot `.data-test/settings.json` before each driver-profile budget test.
- Restores original file content after each test, or removes file when it was absent.
- Invalid `driverProfileMaxOutputTokens: 511` fixture still exercises fallback to 5,000 tokens without leaking into later tests.

## Verification

Command: `bun test test/runtime/settings.test.ts --timeout 30000`

Result: 8 pass, 0 fail, 27 expect() calls.

Expected warning output appeared once for the invalid-budget test:

- `[Settings] Failed to load .../.data-test/settings.json` with `driverProfileMaxOutputTokens` too small (minimum 512).
- `[Settings] Falling back to defaults`

The AI model discovery test also logged its expected local endpoint 503 handling; no repeated settings fallback warning occurred after cleanup.
