# Integrations

Cross-runtime contracts and helpers for external systems.

## Layout

- `ai/` — prompt snippets, locale instructions, and model context-window policy.
- `forza/` — Node-only ZIP/LZX extraction and install discovery. Preserve decoder license notices.
- `motec.ts` — stable persisted MoTeC session marker and browser-safe support predicate.
- `raceiq-online.ts` — browser-safe Online DTOs and port, frozen by [the shared contract](../../docs/plans/raceiq-online-contract.md); credentials and transfer enforcement stay backend-only.

## Boundary

AI and MoTeC leaves must remain portable across browser and server. Forza leaves may use Node APIs and must never enter client bundles. Parsing, persistence, database access, and provider SDK setup remain in server or script domains.

Import explicit leaves; do not add an integrations barrel.
