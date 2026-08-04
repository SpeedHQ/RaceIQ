# Game feature coverage

RaceIQ supports five games, but not every product surface or telemetry source is equivalent. This page records deliberate product and source gaps. It does not treat missing fixture evidence as an unsupported feature.

Canonical sources:

- `client/src/lib/game-routes.ts` owns navigation support for Driver, Experiments, Raw, and Setups. Shared Driver and Experiments routes enforce the same capability table.
- Dedicated route modules own live dashboards, including `client/src/routes/iracing/live/`.
- `shared/games/*/index.ts` owns high-level telemetry and analysis capabilities.
- [Telemetry reference](telemetry.md) points to generated field-level coverage. Do not duplicate that matrix here.
- [End-to-end testing](../contributing/e2e-testing.md) records fixture and external-service limits separately.

## Product surfaces

`No` means RaceIQ intentionally withholds that route or workflow for the game. It does not mean the route is merely untested.

| Surface | Forza Motorsport 2023 | F1 2025 | ACC | AC Evo | iRacing |
| --- | --- | --- | --- | --- | --- |
| Game landing, sessions, analyse, compare, chats, tracks, and cars | Yes | Yes | Yes | Yes | Yes |
| Live dashboard | Yes | Yes | Yes | Yes, using shared Kunos dashboard | Yes, specialized Driver and Pit views |
| Driver profile | Yes | Yes | Yes | Yes | No |
| Setup Engineer experiments | No | Yes | Yes | Yes | No |
| Setup and tune library | Yes | Yes | Yes | Yes | No |
| Raw telemetry | Yes | Yes | Yes | Yes | Yes |
| World-space racing-line and track-map analysis | Yes | Yes | Yes | Yes | No; live SDK supplies lap distance rather than stable world positions |

## Current game gaps

### Forza Motorsport 2023

- No Setup Engineer experiment workflow. Setup and tune browsing remains available.
- Three fantasy tracks intentionally have no curated corner roster because no real-world turn-by-turn guide exists. See [track curation](../contributing/track-curation.md).

### F1 2025

- Setup Engineer changes are advisory. RaceIQ cannot write them into the game.
- Surface-condition analysis is unavailable because the source does not provide the required channel.
- Track rosters are complete, but rendered segment placement is not yet human-verified.

### Assetto Corsa Competizione

- Surface-condition analysis is unavailable because the source does not provide the required channel.
- Some track centerlines still use preserved `fastlane.ai` racing-line geometry until their boundary-derived centerlines and corner rosters are re-curated. This is tracked by the shrink-only gap register described in [track curation](../contributing/track-curation.md).
- Per-car setup range curation remains incomplete. See [per-car setup ranges](../project-status/per-car-setup-ranges.md).

### Assetto Corsa Evo

- Native setup inspection depends on evidence extracted from an installed game. The UI reports it unavailable when that evidence is absent.
- Some centerlines still under-detect individual corners; accepted cases remain in the shrink-only track gap register.
- Click-to-real-value setup mappings remain unverified for clamping and control availability. See [per-car setup ranges](../project-status/per-car-setup-ranges.md).

### iRacing

- No Driver profile, Setup Engineer experiment, or setup/tune-library route.
- No stable world-space racing line from the live SDK. Track analysis uses authoritative lap distance and native sector starts instead.
- No continuous per-wheel rotation, slip ratio, slip angle, or tyre-force channels for the corresponding analysis views.
- Tyre temperature and health are pit snapshots; tyre pressure is a static cold setup value.
- RaceIQ reads setup and session identity but does not write garage setup values back to iRacing.

## Cross-game source differences

- iRacing is the only adapter with authoritative native sector starts. Other adapters use RaceIQ sector and track-curation paths.
- F1 and ACC explicitly mark surface analysis unavailable. iRacing supplies vehicle-level surface state rather than per-wheel surface state.
- Weather freshness differs where available: F1 is continuous and AC Evo is static. Field-level support for every game belongs in the generated [telemetry compatibility matrix](../../shared/telemetry/catalog/generated/telemetry-catalog-matrix.md).

Update this page when route capability guards or high-level adapter semantics change. Update generated telemetry artifacts instead when parser field coverage changes.
