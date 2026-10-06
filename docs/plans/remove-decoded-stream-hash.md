# Remove decoded-stream fingerprinting

ADR: [Decision](../adr/0008-remove-decoded-stream-hash.md).

## Requirements
Remove normalized packet-stream SHA256 from race reconciliation, including its per-packet JSON.stringify, while preserving raw capture hashing, race accumulation, fallback behavior, derived results, and processing provenance. Cleanly remove obsolete canonical-input provenance type/field and all fixtures/callers. Audit remaining JSON stringification for evidence-backed improvements; distinguish small result comparisons from native full-packet serialization.

## Steps
1. Remove decoded hashing and canonicalInput contracts; preserve unrelated changes and rawInput identity. Keep existing result processor ID unless derived outcome semantics change; do not force historical backfill solely for metadata removal.
2. Inspect remaining JS stringify sites and native F1 borrowed serialization. Measure current retained recording consumer with/without fingerprint work; prove identical race-source observations. Evaluate serializer changes conservatively; do not replace packet fidelity with reduced output.
3. Run affected reconciliation/raw-identity/stale-job suites and an actual production reconciliation smoke. Record performance/serializer findings outside checkpoint. Update changelog, performance docs and prior proposed parity documentation to reflect removed packet hashing.

## Acceptance
No production decoded-stream fingerprint generation or obsolete canonicalInput contract. Raw identity and result/fallback behavior remain valid. End-to-end reconciliation exercised; remaining serializer recommendations backed by measured or explicitly scoped evidence. Commit and push this change when requested; preserve unrelated worktree changes.
