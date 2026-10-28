# UI remediation plan

Shared contract: [release-readiness-remediation-contract.md](./release-readiness-remediation-contract.md). Backend plan: [release-readiness-remediation-backend-plan.md](./release-readiness-remediation-backend-plan.md).

## Scope and ownership
Repair client type errors and consumer-visible failures in iRacing incident navigation, replay/Compare and browser integration. Own `client/src/components/iracing/IRacingIncidentReport.tsx`, related route-search types/generated route tree only if required, client tests, and relevant Playwright tests. Do not change backend response contracts.

## Acceptance criteria and edge handling
- **UI1:** incident replay uses `useNavigate` and shared `Button`, retains target game/session/lap and replay frame, and clears stale optional search values. Null replay remains non-navigable. Maps to IC1 and E1/E5.
- **UI2:** replay/analyse/Compare keep distinct track/car/lap selection, measured geometry disclosure, unavailable coordinate state, and real telemetry gaps. Maps to IC2/IC4 and E5.
- **UI3:** production import, catalog/session routes, loading/error/retry states work in compiled app; failures are not masked. Maps to IC3/IC4 and E5.
- **UI4:** TypeScript and browser build errors resolved without relaxing route types. Maps to R1.

## Tasks
1. Fix typed replay navigation and add/update regression proof for route path parameters plus all required search fields.
2. Inspect every browser failure trace from the retained E2E artifact; trace to client logic only when the production response and server are valid.
3. Repair deterministic UI issues and keep route/error assertions meaningful.
4. Coordinate any discovered contract mismatch in shared contract before dependent implementation continues.

## Verification and E2E
- Focused client test(s) for incident replay navigation/route state.
- `bun check --build` in client and `bunx turbo run typecheck --concurrency=1 --force` after integration.
- Existing compiled Playwright scenarios: fresh-install, sessions/import, seeded iRacing compare, replay/spectate, and route/error state. Setup: disposable candidate checkout + isolated seeded DB; action through real browser; assert route, telemetry/geometry state, absence of console errors and correct visible unavailable/error states. These scenarios define E5 and exercise IC1–IC4; isolated component mocks do not satisfy this.
- Final integration owner runs all compiled Playwright projects; UI completion depends on passing shared E2E and recording failures/skips.

## Status
In progress.
