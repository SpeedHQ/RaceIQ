---
status: accepted
---
# Hash retained LMU opponent data inline

Update SHA-256 immediately after the companion writer accepts each buffer, including the header. Publish the digest only after the writer closes successfully. Keep the existing manifest format. Do not reread the file at stop or hash in the shared writer’s batch drain.

Live frame delivery matters more than isolated write-call or shutdown time. All three strategies retained every frame in the [250 Hz comparison](../contributing/performance-benchmarks.md#decision-inline-sha-256-for-retained-lmu-opponents). Inline hashing missed the fewest deadlines and requires no batch callback. The difference was small; it is not evidence of fewer drops in production. Revisit if a representative Windows session shows deadline misses or sustained queue growth attributable to hashing.

Plan: [Inline companion integrity checks](../plans/inline-companion-sha256.md).
