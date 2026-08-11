# Tune semantic telemetry migration

Changed semantic consumer plumbing in `client/src/components/tunes/review/TuneReviewDashboard.tsx` and `client/src/components/tunes/track-focus/TrackFocusView.tsx`, plus semantic sample helpers in `client/src/components/tunes/semantic-tune.ts`, tire snapshots, and sector ranges. Semantic values are read by catalog IDs (`tire.temperature.average`, `tire.pressure`, `tire.wear`, `brakes.brake-temp`) without packet reconstruction.

Verification: `bunx tsc --noEmit --pretty false` from `client` completed with no output.

Semantic gaps: Track Focus map geometry still needs its packet-shaped geometry consumer converted to semantic position/distance IDs; no raw/dev or recording paths changed.
