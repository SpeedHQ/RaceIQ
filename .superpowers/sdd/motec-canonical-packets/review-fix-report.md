# MoTeC Canonical Packets Review Fixes

- Replay packet sources now translate stored offsets using `offsetEncoding`, including legacy fixed-record offsets, before per-lap and batched slicing.
- Replay normalization clones canonical source packets first, preventing cached packet mutation and alternating coordinate normalization.
- AC Evo converters attach `carModelName` only when `CarOrdinal` is unknown (`-1`).

Verification:
- Focused MoTeC suite: 50 passing, 0 failing.
- Native regression suite: 21 passing, 0 failing.
- Typecheck: passed.
