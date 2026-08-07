
## Review follow-up

Corrected ownership predicate to exclude only explicit `others`, preserving legacy NULL/unknown rows as owned after normalization. Restored `trackOrdinal` in telemetry LapMeta assembly. Verified parser-version projection remains present.

Additional verification:

```text
bun test test/db/lap-ownership.test.ts test/telemetry/dynamic-sector-persistence.test.ts
```

Result: 3 passed, 0 failed, 10 assertions.
