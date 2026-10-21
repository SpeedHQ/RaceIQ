# Remove decoded-stream fingerprinting

ADR: [Decision](../adr/0008-remove-decoded-stream-hash.md).

## Requirements
Remove normalized packet-stream SHA256 from Bun race reconciliation, including its per-packet JSON.stringify, while preserving raw capture hashing, race accumulation, fallback behavior, derived results, and processing provenance. Cleanly remove obsolete canonical-input provenance type/field and all fixtures/callers. Leave small derived-result comparisons unchanged.

## Steps
1. Remove decoded hashing and canonicalInput contracts; preserve unrelated changes and rawInput identity. Keep existing result processor ID unless derived outcome semantics change; do not force historical backfill solely for metadata removal.
2. Exercise Bun capture replay, result derivation, raw identity and SQLite persistence; confirm repeated reconciliation is unchanged and partial-source failures do not leak evidence into fallback.
3. Run affected reconciliation/raw-identity/stale-job suites. Update changelog and architecture/performance documentation. Historical matched consumer measurements are not end-to-end Bun recording claims.

## Acceptance
No production decoded-stream fingerprint generation or obsolete canonicalInput contract. Raw identity and result/fallback behavior remain valid. End-to-end Bun reconciliation exercised. Commit and push this isolated change with Bun benchmark tooling when requested; preserve unrelated worktree changes.
