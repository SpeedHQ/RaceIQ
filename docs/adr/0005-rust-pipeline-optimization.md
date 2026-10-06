---
status: proposed
---
# Preserve fixture semantics while optimizing Rust pipeline

Full-presentation JSON construction dominates measured F1 parse time; compact detection is already faster but is not equivalent presentation work.

Optimize production allocation, state reuse and detector processing under a full-output differential fixture gate. Keep existing full-presentation benchmark unchanged. Measure release throughput before/after on identical records, and memory in independent processes. Reject changes that alter packet/event semantics or regress representative workloads.

Rationale: reducing work through compact-only output would hide cost rather than satisfy output fidelity. Exact fixture comparison protects cached state and detector transitions that packet counts alone cannot validate.

Retain dense insertion-ordered presentation maps, capacity reservations, fixed F1 numeric arrays, owned history merging and cached detector game classification. Dense maps trade higher sampled RSS in several fixture workloads for lower combined parsing/processing time. A global mimalloc trial produced mixed gains and processing regressions; do not introduce that dependency.

Binary decoding and detector policies do not require JSON. Existing presentation/replay consumers still require full `Value` output in this change; a typed-presentation cutover would need migration of those consumers and boundary serialization, not a compact-output benchmark substitution.

Plan: [Rust pipeline optimization](../plans/rust-pipeline-optimization.md).
