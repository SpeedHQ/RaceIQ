---
status: proposed
---
# Remove decoded packet fingerprints from reconciliation

Race reconciliation serializes every normalized packet solely to compute a persisted decoded-stream fingerprint. Auditing found no correctness consumer: derivation uses RaceSourceAccumulator; raw capture identity and extractor/derivation versions already provide source and processing provenance. The fingerprint participates only in persisted provenance and unchanged reporting.

Remove per-packet stringify/SHA256 and obsolete canonicalInput provenance contracts. Retain raw capture hashing and processing metadata. Exact decoded-output fidelity remains a regression/diagnostic concern rather than unconditional recording-finalization work.

Consequence: provenance no longer identifies exact normalized packet bytes or detects parser nondeterminism by itself. Do not hash native JSON bytes as a substitute; normalization and JSON representation differ. Preserve result processor ID when only provenance metadata changes, avoiding forced replay of historical sessions solely for fingerprint removal.

Plan: [Removal and serialization audit](../plans/remove-decoded-stream-hash.md).
