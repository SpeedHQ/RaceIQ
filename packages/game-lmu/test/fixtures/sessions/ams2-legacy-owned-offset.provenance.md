# AMS2 legacy lap ownership fixture

This fixture comes from a real AMS2 direct capture with 9,092 driving frames before the owned lap. The original saved lap starts at native byte offset 223,699,588 and contains 4,157 frames. Its saved time is 52.990020751953125 seconds.

The fixture contains one recording chunk. Participant names and bytes beyond the known AMS2 shared-memory layout were zeroed before re-encoding. Frame lengths in native coordinates, timing, order, and ownership were preserved. The test generates fresh database rows and manifest identifiers. The fixture contains no copied profile database.

Run from the repository root with Bun:

```sh
bun test packages/game-lmu/test/e2e/backend/session-capture/direct-capture-repair.test.ts -t "recorded driving prefix"
```

To check the baseline, run the same test and fixture in a disposable checkout at `900faf29b`. Copy the test file and fixture into the same repository-relative paths. The old maintenance code rejects the lap with an ownership mismatch. With the repair, the test verifies the restored link and native frame range, preservation of the saved lap row and chunk bytes, and a successful repeat pass.

SHA-256 of the decompressed fixture is `665eaa2a9ea93323b2a0709e929bd8f6d9bcb726fe17d897805b190369222b33`.
