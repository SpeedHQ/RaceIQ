# Telemetry reference

RaceIQ keeps field-level telemetry claims in generated artifacts, not hand-maintained markdown.

- `shared/telemetry/catalog/generated/TELEMETRY_CATALOG.md`: exhaustive variable inventory and semantic coverage.
- `shared/telemetry/catalog/generated/telemetry-catalog-matrix.md`: per-game matrix with availability and source-kind (packet, extension, SDK, session info).

Regenerate with `bun run telemetry:catalog` when parser coverage changes.

## Input paths

- **Forza Motorsport 2023** (`fm-2023`) — UDP packets on port `5301` (`server/runtime/udp-listener.ts`).
- **F1 25** (`f1-2025`) — UDP packets on port `5301` (`server/runtime/udp-listener.ts`).
- **Assetto Corsa Competizione** (`acc`) — Windows shared-memory triplets (`acpmf_*`).
- **Assetto Corsa Evo** (`ac-evo`) — Windows shared-memory triplets (`acevo_pmf_*`).
- **iRacing** (`iracing`) — Windows SDK memory map (`Local\\IRSDKMemMapFileName`).

## Adapter-specific details

- [ACC adapter](adapters/acc.md)
- [iRacing adapter](adapters/iracing.md)

## Related architecture

- [Telemetry recording](../architecture/telemetry-recording.md)
- [Session storage](../operations/session-storage.md)
- [Lap detection](../architecture/lap-detection.md)
