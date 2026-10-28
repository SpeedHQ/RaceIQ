# Release-readiness remediation integration contract

UI: [release-readiness-remediation-ui-plan.md](./release-readiness-remediation-ui-plan.md)  
Backend: [release-readiness-remediation-backend-plan.md](./release-readiness-remediation-backend-plan.md)

## Scope
Repair existing integration behavior only. Preserve repository-defined routes, types, authentication, serialization, ordering, and data semantics. Do not introduce compatibility aliases or change endpoint payloads to conceal failures.

## Authoritative existing contracts
- iRacing incident response/event types: [`shared/racing/sessions/iracing-incidents.ts`](../../shared/racing/sessions/iracing-incidents.ts).
- Route and replay query contracts: [`client/src/routes/$gameid/sessions/$sessionId/replay/$lapId.tsx`](../../client/src/routes/$gameid/sessions/$sessionId/replay/$lapId.tsx), [`client/src/lib/game-routes.ts`](../../client/src/lib/game-routes.ts), and generated `client/src/routeTree.gen.ts`.
- Compare/aligned telemetry request and response: [`client/src/components/comparison/LapComparison.tsx`](../../client/src/components/comparison/LapComparison.tsx), [`server/db/telemetry-replay-storage.ts`](../../server/db/telemetry-replay-storage.ts), and the backend route implementation/tests.
- Recording and import ownership/source-byte contracts: [`apps/backend/src/imports/iracing-ibt.ts`](../../apps/backend/src/imports/iracing-ibt.ts), [`server/session-capture/README.md`](../../server/session-capture/README.md), and production import E2E.

## Integration invariants
1. Incident replay selection targets the same game/session/lap path, sets cursor to the event frame, clears incompatible optional replay/opponent selection fields, and uses router navigation rather than an anchor.
2. Compare uses two distinct lap IDs, same track and car; backend aligned telemetry response is the real production response, with measured source coordinate offsets preserved. Errors remain observable; no fake API fallback.
3. IBT import keeps source bytes unchanged, associates laps with the source session, and only reports valid laps as comparable.
4. Missing capture/coordinates and real telemetry gaps remain unavailable/gapped; never synthesize measurements or replace assertions with permissive defaults.

## Shared integration acceptance criteria
- **IC1:** incident event replay button navigates to exact route params and frame cursor without dropping unrelated required route-search keys.
- **IC2:** two real imported iRacing laps load through production compare API; replay scrubbing changes cursor; boundary/reference disclosure remains visible.
- **IC3:** production IBT browser import succeeds with correct ownership and retained source; application displays returned sessions/laps.
- **IC4:** on failed/unavailable evidence, UI shows the declared state while production API errors remain visible in diagnostics.

## Examples
- Event `{sessionId: 10, lapId: 28, replay: {frameIndex: 53}}` navigates to `/iracing/sessions/10/replay/28?cursor=53` with other route search fields explicitly cleared/false as defined by the route validator.
- Compare selection `{trackId: "515", carAId: "67", carBId: "67", lapAId: 28, lapBId: 32}` uses production aligned telemetry for both laps; no duplicated ID substituted for the distinct pair.
- An imported IBT remains byte-for-byte identical to uploaded source; invalid/incomplete lap classification follows the import contract rather than being promoted to valid.

## Cross-layer E2E owner
The remediation integrator owns execution and evidence collection for IC1–IC4 via existing compiled Playwright suites and isolated manual app smoke. UI and backend implementers may use fixtures only for unit tests; production integration validation must run against candidate server and real imported capture.
