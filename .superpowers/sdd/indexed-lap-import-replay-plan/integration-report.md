# Integration Report

## Indexed adapter/import path

Command:
```sh
bun test test/games/ac-evo/ac-evo-batch-decode.test.ts --timeout 120000
```

Result: pass — 1 pass, 0 fail, 21 expect() calls. AC Evo parser resolved Brands Hatch/Porsche fixture and completed batch decode assertions.

Implemented:
- `LapIndexPacket` detector-facing projection contract.
- `tryParseLapIndex` and `primeParserState` hooks on FM, F1, ACC, AC Evo, and iRacing adapters (fallback full parse/projection for parity-safe behavior).
- Metadata-only pipeline entrypoint preserving recorder and detector ordering while skipping live publication stages.
- Canonical frame import routed through index parser and metadata pipeline; packet-backed imports unchanged.
