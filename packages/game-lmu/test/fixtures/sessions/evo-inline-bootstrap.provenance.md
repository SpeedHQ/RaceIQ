# EVO inline parser bootstrap fixture

This is the first auxiliary chunk from a real AC EVO recording that startup maintenance rejected with `parser bootstrap is missing`. The original parser checkpoint begins at stored offset 28, exactly at the first source record. The chunk also includes its recorded trailing frame. The driver name and surname fields were zeroed. The checkpoint, native coordinates, record framing, and timestamps were preserved. This fixture contains no lap or profile database.

Run from the repository root:

```sh
bun test packages/game-lmu/test/e2e/backend/session-capture/direct-capture-repair.test.ts -t "recorded inline parser bootstrap"
```

The same test and fixture at baseline `900faf29b` reproduce the missing-bootstrap error. With the fix, maintenance publishes the manifest, preserves the chunk bytes, and succeeds on a repeat run. The AMS2 ownership fixture separately tests restoration of a saved lap link.

SHA-256 of the decompressed fixture is `889bab273c365a7423ab5298a1518a15eddb8a6230a4f37203e4bb3aed4cc49a`.
