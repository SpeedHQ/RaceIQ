# RaceIQ Documentation

Documentation is organized by audience. Start with a user guide; use contributor and architecture pages when changing RaceIQ.

## Users

- [OpenAI-compatible AI setup](user-guides/openai-compatible-ai.md) — connect RaceIQ to LM Studio, Ollama, OpenRouter, LiteLLM, or another compatible provider.

## Contributors

- [Contributing](../CONTRIBUTING.md) — repository entry point and contribution workflow.
- [Development](contributing/development.md) — install, run, seed data, and manage schema changes.
- [Frontend development](contributing/frontend.md) — component ownership, live-state boundaries, and routing contracts.
- [Performance benchmarks](contributing/performance-benchmarks.md) — run parser, replay, and process-isolated performance measurements.
- [Track curation](contributing/track-curation.md) — curate and verify track metadata and geometry.
- [Telemetry recordings](contributing/telemetry-recordings.md) — capture, import, and preserve development telemetry.
- [Test troubleshooting](contributing/test-troubleshooting.md) — diagnose test processes that do not exit.
- [End-to-end testing](contributing/e2e-testing.md) — audit route surfaces, seeded five-game coverage, telemetry semantics, and visual evidence.
- [Setup range data](contributing/setup-range-data.md) — maintain game setup limits and provenance.

## Architecture

- [Overview](architecture/overview.md) — service boundaries, five game adapters, ports, and telemetry flow.
- [Race results](architecture/race-results.md) — persisted results, pit events, provenance, and reconciliation.
- [Setup Engineer](architecture/setup-engineer.md) — tuning experiment and agent boundaries.
- [Track calibration](architecture/track-calibration.md) — live/static transform lifecycle, fit requirements, and verification.
- [Telemetry recording](architecture/telemetry-recording.md) — raw capture, replay, and reprocessing formats.
- [Lap telemetry cache](architecture/lap-cache.md) — in-memory cache policy and invalidation.
- [Lap detection](architecture/lap-detection.md) — per-game detector behavior and lifecycle.


## Reference

- [Game feature coverage](reference/game-feature-coverage.md) — product-surface and high-level source gaps across supported games.
- [Telemetry reference](reference/telemetry.md) — field availability, provenance, and limitations by game.
- [ACC adapter](reference/adapters/acc.md) — ACC shared-memory behavior.
- [iRacing adapter](reference/adapters/iracing.md) — iRacing SDK and import behavior.
- [Generated telemetry catalog](../shared/telemetry/catalog/generated/TELEMETRY_CATALOG.md) — exhaustive generated fields and semantics.
- [Generated telemetry compatibility matrix](../shared/telemetry/catalog/generated/telemetry-catalog-matrix.md) — cross-game semantic coverage.
- [Community tunes](integrations/community-tunes.md) — CDN publishing and synchronization contract.
- External source specifications:
  - [ACC shared-memory specification](reference/external/acc/acc-shared-memory-v1.8.12.pdf)
  - [AC Evo shared-memory specification](reference/external/ac-evo/ac-evo-shared-memory-v1.pdf)
  - [F1 25 UDP specification](reference/external/f1-25/f1-25-udp-specification-v3.pdf)

## Operations

- [Session storage](operations/session-storage.md) — compression, cleanup, and orphan handling.

## Research

- [Telemetry fidelity](research/telemetry-fidelity.md) — fixture-backed capture-frequency and duplicate-frame findings.

## Active work

Only unresolved work belongs here.

- [Project status index](project-status/README.md)
- [Setup Engineer](project-status/setup-engineer.md)
- [Per-car setup ranges](project-status/per-car-setup-ranges.md)
