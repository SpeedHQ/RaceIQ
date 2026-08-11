# Task 3 Report

## Changes
- Added `readCollectionPath` for `[]` collection segments; ordinary `readPath` remains unchanged.
- Resolver native/source lookup now resolves ordered collection values, including nested `f1.grid[].*` paths.
- Extracted exported `canonicalTelemetryValue(slot, resolved)` into shared replay canonicalization; server replay uses it without changing envelope shape or internal `SemanticSlot`.
- Added focused F1 collection-path resolver coverage for driver name, position, gap-to-leader, and sector S1.

## Verification
Command:
```sh
bun test test/telemetry/resolver/native-sources.test.ts test/telemetry/resolver/basic.test.ts test/telemetry/storage.test.ts test/games/shared/semantic-replay-native.test.ts
```
Result: **20 pass, 0 fail, 65 expect() calls** across 3 files.
