# Task final callsites report

Command: `bunx tsc -b client/tsconfig.json --pretty false`

Exact output:

```text
6 diagnostics in 4 files
Top codes: TS2304 (4x), TS2322 (1x), TS6133 (1x)
client/src/components/tunes/LiveTestDashboard.tsx (2 diagnostics)
  error TS6133: 'useRef' is declared but its value is never read.
  error TS2304: Cannot find name 'lastRawRef'.
client/src/components/tunes/review/TuneReviewDashboard.tsx (2 diagnostics)
  error TS2304: Cannot find name 'TuneIssue'.
  error TS2304: Cannot find name 'TuneIssue'.
client/src/components/telemetry/Vitals2D.tsx (1 diagnostics)
  error TS2322: Type '{ packet: TelemetryPacket; }' is not assignable to type 'IntrinsicAttributes & { frame?: SemanticAnalysisFrame | undefined; view?: LiveTelemetryView | undefine…
client/src/components/tunes/track-focus/TrackFocusView.tsx (1 diagnostics)
  error TS2304: Cannot find name 'SemanticAnalysisFrame'.
  Property 'packet' does not exist on type 'IntrinsicAttributes & { frame?: SemanticAnalysisFrame | undefined; view?: LiveTelemetryView | undefined; }'.
[raw output: artifact://1154]
```
