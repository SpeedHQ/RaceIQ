---
name: raceiq-cloud-deployment-smoke-runtime
description: Run RaceIQ Cloud deployment smoke safely alongside an existing stack; recognize OrbStack isolation limits and keep policy fixtures deterministic.
---

# RaceIQ Cloud deployment smoke

Use the repository's `bun --no-env-file run smoke:deployment`. Keep all application data and Compose resources isolated; do not change live Infisical configuration or delete another stack's resources.

## Concurrent-stack setup

Inspect existing Docker network allocations before selecting test settings. The default ingress subnet `172.30.0.0/24` may belong to the running RaceIQ stack. Override all related settings together, choosing unused addresses:

```sh
ADMIN_DASHBOARD_PORT=32942 \
PUBLIC_INGRESS_SUBNET=172.31.240.0/24 \
PUBLIC_INGRESS_DYNAMIC_RANGE=172.31.240.128/25 \
TUNNEL_INGRESS_IP=172.31.240.2 \
bun --no-env-file run smoke:deployment
```

These addresses are examples, not permanently reserved values.

## Required runtime boundary

Release network-isolation proof requires standard Linux Docker/CI. OrbStack intentionally allows cross-bridge container traffic; separate Compose networks do not provide the expected isolation there. Both `default` and `orbstack` contexts can point to OrbStack, so inspect the actual engine rather than assuming context names establish independence.

Primary evidence: https://github.com/orbstack/orbstack/issues/1944 — maintainer describes cross-bridge communication as intentional and OrbStack as a development tool, not a production-isolation runtime.

An ingress-only probe reaching the dashboard health endpoint on OrbStack is a failed qualification, not permission to skip the assertion. Setting `dashboard-private` to `internal: true` was tested and broke operator loopback access in this environment; that workaround was reverted. Do not repeat it without new evidence.

If no standard Linux engine is available, report the gate blocked. Creating privileged Docker-in-Docker requires explicit user authorization; never mount the host Docker socket as a shortcut.

## Known repository fixes and invariants

- API image builds only `raceiq-server` and `raceiq-admin`. `--bins` also builds the activity-contribution vector utility, whose input is absent from the production image context.
- Deployment smoke supplies its own Terms/Privacy versions and HTTPS fixture URLs. Missing policy config correctly makes the processor unavailable and withholds queue metrics; do not weaken readiness checks or synthesize metrics.
- Do not pin deployment smoke to historical migration version/count 21. Validate real startup and behavior instead.
- Existing migration checksums are immutable. Statistics correction was added through migration 0049, not by changing migration 0045.
- `/friends/leaderboard` and `/me/leaderboard` provide authenticated private/no-store website personalization without public-sharing/current-consent prerequisites. Protected `/leaderboard`, `/records`, and recording access retain Community entitlement checks. Do not conflate those endpoint groups in smoke assertions.

## Resource failures

Docker image extraction can fail with `no space left on device` after successful release compilation. Do not claim image/runtime success from compilation alone. Obtain permission before pruning unrelated cache. A narrowly approved cleanup was `docker builder prune --force --filter until=24h`; it does not authorize image, container, volume, or broader cache deletion.

Run the large Rust regression suite without concurrent Docker release compilation when possible. The existing 500 MB recording-boundary test is expensive; a contended 600-second run timed out, while the complete serial suite passed. Preserve assertions and distinguish resource contention from actual regressions.

Full smoke evidence is emitted under `.omp/evidence/unix-deployment-smoke-<pid>.log`. Report successful stages and the precise remaining failure separately; never represent partial OrbStack execution as release readiness.
