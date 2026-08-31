# Kunos MoTeC preparation parity

- `prepareKunosMotecCapture` now branches by profile: AC Evo integrates native ROTY before 60 Hz projection, applies closed-lap correction, centers suspension travel, and rigidly aligns each lap to its track ordinal; ACC remains unaligned and uses prior generic closure/sign/unit behavior.
- Shared `deadReckonPath` and `alignPathToTrack` retain intentional exports for converter/tests.
- TypeScript compilation reports no diagnostics for `server/motec/kunos-synthesis.ts`.
- Focused visualization test could not execute because it still imports removed legacy `SYNTH_HZ`/`synthesizeAcEvoCapture` exports; converter test migration is handled by the parallel direct-converter work.
