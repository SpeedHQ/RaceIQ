
## Follow-up quality fix

Added a regression fixture that creates a nullable pre-migration ownership column containing both `NULL` and an unsupported legacy value before v58 runs. Test asserts both normalize to `mine`.

Follow-up verification:

```text
bun test test/db/migrations/migration-regression.test.ts
```

Result: 6 passed, 0 failed, 12 expectations.
