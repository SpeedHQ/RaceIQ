---
status: accepted
---
# Separate the installation user, personal stints and merged Online lifetime activity

Design confirmed 2026-10-21; implementation and deployment authorization are separate. RaceIQ remains offline-first. Scope amendment on 2026-10-21: the user withdrew the earlier multi-local-profile/account-switching requirement as scope creep. Support one local user per installation with existing single-account auth, not a profile picker, per-profile libraries or account-replacement flow. First Discord sign-in claims unassigned owned history, never borrowed originals; original cloud ownership remains immutable after sign-out or a different login.

Verified native identity or explicit per-game binding establishes Self/Other/Unknown stint attribution. Shared-car swaps never switch RaceIQ accounts; only wholly Self laps are personal completions/upload candidates. Personal time excludes Other/Unknown while retaining separate shared-session context. Reuse dashboard time, favourites, counting and local periods rather than introduce a competing aggregation system.

Online profile sync is automatic after auth and explicit current-policy acceptance, independent of public recording/setup sharing. Merge uniquely identified original activity across devices once; preserve synced lifetime contributions after local deletion, replace same-original corrections even when totals decrease, and hold ambiguous legacy identity. Online profile is public all-time only, not dated history or the last device snapshot.

Every lap has a persistent globally unique GUID preserved across representations/imports/downloads. Server-authoritative owner and canonical recording-identity checks reject known copied laps despite changed GUID/request key; an identifier alone is not authenticity proof. Native unsigned telemetry cannot support an absolute anti-tamper guarantee. Legal wording states best-effort validation/moderation/removal, not guaranteed accuracy or tamper-free submissions.

Support fastest valid wholly personal lap per game/track/car for ACC, AC Evo, F1 2025, iRacing and LMU. Reject Forza recordings/setups in app/server; allow aggregate Forza statistics. Run preparation/transfer and Effect PersistedQueue/SQLite delivery in one supervised Bun worker, retaining business identity/receipt/history separately. Main-thread fibers/in-memory counters, device-total summation, fuzzy duplicate matching and reauthoring imports are rejected alternatives.

Settings → Upload exposes read-only queue/status/history with automatic retries. Public sharing off stops future recordings, not existing public publication. Track Details → Laps shows actual Community times and Open Replay only for signed-in/current-consent/confirmed-public-sharing drivers; no minimum published lap. Backend guards direct/retry/revocation paths, preserves source GUID/author and opens exact replay. Local replays remain offline-usable. Policy version changes pause both recording/profile sync until explicit re-acceptance.

Tradeoff: profile/attribution/provenance migrations, worker RPC and original-identity/correction contracts cost more than snapshot replacement, but avoid stolen attribution, duplicate lifetime totals, cross-account activity leakage and main-thread upload work. Per-game evidence, canonical identity and actual E2E remain implementation gates, not facts established by this ADR.

Plan: [Desktop backend implementation](../plans/raceiq-live-service.md).
UI plan: [Single-account auth, Upload and Community replay](../plans/raceiq-online-ui.md).
Shared contract: [Release operations and acceptance](../plans/raceiq-online-contract.md).
Cloud plan: [Parallel service implementation](../../../../../projects/raceiq%20cloud/docs/plans/raceiq-online-deployment-backend.md).
Language: [Domain glossary](../../CONTEXT.md).
