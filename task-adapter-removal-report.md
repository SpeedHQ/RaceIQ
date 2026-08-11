# Task: Semantic Replay Adapter Removal

- Targeted source search: no remaining `semantic-replay`, `semanticReplayToAnalysisFrames`, or `canonicalValueForPacketField` references under `client`.
- Removed obsolete `client/src/lib/semantic-replay.ts` packet reconstruction adapter.
- Removed its dedicated `client/test/semantic-replay.test.ts`, which only exercised the deleted adapter API.
- No resulting unused imports or types required cleanup in remaining sources.
- Client typecheck passed: `bunx tsc --noEmit -p tsconfig.json` from `client/`.
- No formatter, linter, or project-wide test suite run.
