---
status: proposed
---
# Recording frequency ceilings and archival retention

Native recording uses a persisted 50–100 Hz ceiling, defaulting to 100 Hz. Existing native acquisition remains fresh; admission precedes expensive frame processing. Live UDP is unchanged.

Historical downsampling is explicit or opt-in, protects favorites, excludes MoTeC and unreliable sources, and preserves replay boundaries and lap identity. Streaming rewrites rebuild sparse and nested iRacing delta chains. Validated sibling output becomes authoritative only through atomic path/index/cap publication. Derived analysis is invalidated.

The downsampling engine belongs to the dedicated `@raceiq/capture-downsampling` package, depending on `@raceiq/capture-formats` for codecs. Generic lap-bundle construction remains in `@raceiq/capture-splitting`; using splitting does not make downsampling a splitting concern. Strict record and game-parser factories cross the downsampling boundary; server-owned DB policy, publication and lifecycle remain in the backend.

One Effect managed runtime owns in-process maintenance and archival jobs. Compression precedes downsampling, which precedes deletion. Enabled deletion must be strictly later than enabled downsampling. Shutdown awaits non-cancellable I/O and finalizers. Progress is not durable across backend restarts.

This avoids source restarts, duplicated sample fabrication, unsafe in-place rewrites, overlapping maintenance and false cancellation guarantees.

Plan: [Approved implementation plan](../plans/recording-frequency.md). Integration: [Shared contract](../plans/recording-frequency-contract.md).
