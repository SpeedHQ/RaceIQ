# Comparison semantic replay

Updated base Compare route to resolve semantic envelopes directly from already-loaded `getLapsByIds` telemetry via `resolveTelemetryReplay`. Constructed replay source metadata from loaded lap metadata, preserving version identity and iRacing native-frame capture loading when available. Removed both per-ID semantic database queries. Other comparison handlers unchanged.

Status: implementation complete.

Files:
- `server/routes/laps/comparison-routes.ts`
- `.superpowers/sdd/indexed-lap-import-replay-plan/comparison-semantic-report.md`

Tests: focused route test not available in this checkout; type/syntax verification pending parent integration.

Concerns: batched lap result type currently does not expose `rawFile`/raw offsets at compile time, so route reads optional runtime metadata when present. This keeps non-iRacing semantic behavior unchanged; iRacing native capture loading depends on that metadata being attached by the loader.
