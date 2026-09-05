
## Additional verification

`bunx tsc --noEmit --pretty false` reports only pre-existing test-global diagnostics in `test/games/f1-2025/f1-indexed-replay.test.ts` (`afterAll`, `describe`, `test`, `expect`); no diagnostics remain in changed server files.
