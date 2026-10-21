# CI screenshot render repair

ADR: [Remove unused production builds from screenshot renders](../adr/0010-screenshot-dev-only-renders.md)

## Requirements

Fix screenshot render shards 1 and 2. Run locally and address observed errors. Preserve all screenshot cases and real seeded application rendering.

Split screenshot rendering into four CI shards. Current and base renders must use the same four-way partition, retaining all 92 cases without duplication or omissions.

## Evidence and decision

PR 430 run 37479397665 reports lost self-hosted runner communication for both screenshot shards during base capture. This does not establish an application assertion failure or prove resource exhaustion. Local current shard 1 passes. Screenshot operations explicitly select dev mode, so compiled artifacts and the base production build are unused.

Remove unused compiled artifact download, base production build, and dist replacement. Keep dependency installation, both shard commands, and comparison behavior unchanged. Do not mask failures or weaken screenshot assertions.

## Steps and acceptance

1. Run both current screenshot shards and both base screenshot shards locally against seeded app.
2. Remove unused production-build operations and document dev-only screenshot execution.
3. Verify runner operation with real screenshot capture and output collection. All 92 cases must pass on each revision; distinguish local macOS verification from unverified Windows runner health.
4. Expand the CI matrix to shards 1–4 and use `--shard=N/4` for both render operations. Verify all four partitions locally.

Infrastructure health cannot be verified from local browser success. A subsequent CI run remains necessary to establish that runner communication failure is resolved.
