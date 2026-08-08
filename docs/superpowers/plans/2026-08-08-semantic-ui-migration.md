# Semantic UI Telemetry Migration Implementation Plan

> **For agentic workers:** Execute task-by-task with focused verification.

**Goal:** Make every non-raw, non-DevTelemetryPanel UI consume catalog-resolved semantic telemetry instead of native `TelemetryPacket` data.

**Architecture:** Keep native packets at the server recording boundary and DevTelemetryPanel only. Extend existing semantic live/replay view contracts for dashboard, Analyse, Compare, tune, and demo needs; migrate page containers and leaf components to semantic values with explicit unavailable states. Remove raw fallbacks from non-raw UI paths.

**Tech Stack:** TypeScript, React, Zustand, Bun, Vite, Playwright, existing telemetry catalog/resolver contracts.

## Global Constraints

- Do not change raw routes or `client/src/components/dev/DevTelemetryPanel.tsx`.
- Do not alter append-only recording bytes or native server capture.
- No UI component outside DevTelemetryPanel may accept `TelemetryPacket` or `rawPacket` as its live data source.
- Preserve unit conversion, catalog IDs, semantic mapping status, replay/live parity, and existing user-visible behavior.
- Use explicit unavailable values; never silently fall back to native packet fields.

---

### Task 1: Inventory non-raw native consumers

**Files:**
- Inspect `client/src/components/**/*.tsx`, `client/src/routes/**/*.tsx`, `client/src/stories/**/*.tsx`
- Inspect `client/src/stores/telemetry.ts`, `shared/telemetry/live/contracts.ts`, `shared/telemetry/replay/contracts.ts`

- [ ] Enumerate every non-raw/non-dev `TelemetryPacket`, `rawPacket`, and packet-derived prop. Classify as live, replay/history, compare, tune, or fixture.
- [ ] Map each field to an existing semantic ID or record a missing contract field requiring extension.
- [ ] Confirm raw route and DevTelemetryPanel paths remain excluded.
- [ ] Record the inventory in the implementation report before edits.

### Task 2: Extend semantic view contracts

**Files:**
- Modify `shared/telemetry/live/contracts.ts`
- Modify `server/telemetry/live-projector.ts`
- Modify `shared/telemetry/replay/contracts.ts` and resolver helpers as required
- Test `client/test/telemetry/live-telemetry-view.test.ts`, `test/telemetry/live-projector.test.ts`, and replay resolver tests

- [ ] Add only missing catalog-backed fields needed by migrated UI: scalar vehicle inputs, wheel/tire values, suspension, lap/sector/pit, identity, and comparison metadata.
- [ ] Preserve `mappingStatus`, `freshness`, source observation, schema/version, and unavailable semantics for every field.
- [ ] Build failing tests for each added field and unavailable-state behavior.
- [ ] Implement projector/resolver output and make focused tests pass.

### Task 3: Migrate live dashboards

**Files:**
- Modify `client/src/components/dashes/ComboDash.tsx`
- Modify `client/src/components/ForzaLiveDashboard.tsx`
- Modify `client/src/components/acc/AccLiveDashboard.tsx`
- Modify shared live telemetry leaf components and semantic view adapters

- [ ] Replace `rawPacket` fallback reads with semantic view values.
- [ ] Route gear, speed, lap, tire, fuel, sector, pit, and issue values through semantic fields/adapters.
- [ ] Render unavailable state when semantic mapping is unavailable.
- [ ] Keep raw packet only in excluded DevTelemetryPanel/raw routes.
- [ ] Add focused component/model tests for mapped and unavailable frames.

### Task 4: Migrate Analyse and Compare

**Files:**
- Modify `client/src/components/analyse/**/*.tsx`
- Modify Analyse/Compare route containers and data loaders
- Modify shared replay/canonicalize adapters as needed

- [ ] Change Analyse panels, wireframe, charts, steering, suspension, ERS, and segment calculations to canonical semantic replay values.
- [ ] Change Compare page data selection and metric calculations to semantic IDs/resolved values.
- [ ] Preserve historical source order, units, lap boundaries, and missing-value behavior.
- [ ] Add focused tests proving semantic IDs drive displayed values and packet-only values are ignored.

### Task 5: Migrate tune, replay, onboarding, and stories

**Files:**
- Modify `client/src/components/tunes/LiveTestDashboard.tsx`
- Modify replay/demo/onboarding consumers outside raw routes
- Modify `client/src/stories/**/*.tsx` fixtures and adapters

- [ ] Replace native live/replay props with semantic view or canonical replay view.
- [ ] Keep fixtures deterministic by constructing semantic frames through the existing test helper.
- [ ] Remove only obsolete packet-shaped fixture plumbing; preserve raw fixtures used exclusively by raw-route tests.
- [ ] Run focused route/component tests.

### Task 6: Remove non-raw native boundaries

**Files:**
- All files identified in Tasks 1–5
- `client/src/stores/telemetry.ts` only where non-dev native state remains

- [ ] Remove `TelemetryPacket` imports/props and `rawPacket` fields from non-raw UI APIs.
- [ ] Keep native packet state and subscriptions only for DevTelemetryPanel/raw tooling.
- [ ] Add static guard/search test or script that fails on non-excluded UI native consumers.
- [ ] Run TypeScript diagnostics and focused test suite.

### Task 7: Verify end-to-end behavior

**Files:**
- No source changes expected; update `CHANGELOG.md` only if repository release-note policy requires it.

- [ ] Run focused semantic live/replay/projector/resolver tests.
- [ ] Run client TypeScript/build.
- [ ] Run full telemetry and recording-fidelity tests.
- [ ] Run browser smoke for live dashboard, Analyse, Compare, replay, and DevTelemetryPanel/raw routes.
- [ ] Confirm recording bytes remain unchanged and raw/dev inspection still works.
