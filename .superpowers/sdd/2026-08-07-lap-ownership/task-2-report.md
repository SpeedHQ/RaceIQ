
## ZIP test strengthening

ZIP validation tests now assert exact ownership error body, proving rejection occurs before malformed archive processing. `bun test test/routes/import-ownership.test.ts`: 2 pass, 0 fail.
