---
status: proposed
---
# Keep dashboard screenshot renders dev-only

Screenshot operations launch Bun backend and Vite client with `E2E_SERVER_MODE=dev`. Downloading compiled current artifacts, building production base artifacts, and replacing current `dist` do not contribute to these renders.

Remove those unused operations while retaining dependency installation, seeded browser cases, shard partitioning, and failure propagation. This avoids unnecessary production compilation during base capture. Both CI shards reported lost runner communication; resource exhaustion is not proven, so this decision does not claim to repair runner infrastructure itself.

Partition both revisions across four render jobs using the same `--shard=N/4` arguments. This reduces each job's screenshot workload while preserving the complete inventory and existing artifact merge behavior.

Plan: [CI screenshot render repair](../plans/ci-screenshot-renders.md)
