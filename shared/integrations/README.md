# Integrations

Cross-runtime contracts and helpers for external systems.

## Layout

- `ai/` — prompt snippets, locale instructions, and model context-window policy.
- `forza/` — Node-only ZIP/LZX extraction and install discovery. Preserve decoder license notices.
- `motec.ts` — stable persisted MoTeC session marker and browser-safe support predicate.
- Online browser-safe DTOs and ports live in [`@raceiq/online/contracts`](../../packages/online/contracts/); credentials and transfer enforcement remain outside the browser. See the [current ownership and implementation plan](../../docs/plans/online-upload-profile-sync.md).

## Boundary

AI and MoTeC leaves must remain portable across browser and server. Forza leaves may use Node APIs and must never enter client bundles. Parsing, persistence, database access, and provider SDK setup remain in server or script domains.

Import explicit leaves; do not add an integrations barrel.
