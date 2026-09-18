# Game Metric Contract Semantic Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `GameAdapter.telemetry` capability an explicit, catalog-backed contract so all five games advertise only metrics whose semantic values and derivation inputs actually resolve.

**Architecture:** Telemetry catalog remains authority for semantic availability, shape, canonical unit, mapping fidelity, freshness, provenance, and limitations. Game adapters remain authority for presentation and game-specific calculation strategy, but each advertised metric gains a typed semantic value binding or typed derivation-input binding. A catalog validator and native-recording tests enforce adapter/catalog/consumer consistency.

**Tech Stack:** TypeScript, Bun, React, generated telemetry catalog, canonical live/replay resolver, existing native recording fixtures, Playwright.

## Global Constraints

- Cover every top-level `TelemetryModel` field and every `AnalysisTelemetryModel` field for `fm-2023`, `f1-2025`, `acc`, `ac-evo`, and `iracing`.
- Keep native packet capture and append-only recording bytes unchanged.
- Keep catalog semantic IDs authoritative; never add client-side packet-shaped translation or raw packet fallback.
- Never represent Forza normalized lateral slip as a physical angle in radians or degrees.
- Prefer an explicit unavailable contract over an uncalibrated derivation or placeholder zero.
- Preserve pit-snapshot and static freshness; zero remains a valid value where the source is available.
- Generated catalog artifacts must be deterministic and current before adapter corrections are accepted.

## Contract Inventory

Top-level bindings:

| Contract | Required semantic binding |
|---|---|
| `fuel` | `fuel.fuel`; optional `fuel.fuel-capacity` |
| `tireTemperature` | `tire.temperature.average` |
| `boost` | `engine.boost` |
| `power` | `engine.power` |
| `torque` | `engine.torque` |
| `brakeTemperature` | `brakes.brake-temp` |
| `tirePressure` | `tires.tire-pressure` |
| `ers` | `fuel.ers-store-energy`; optional deploy mode/deployed/harvested channels |
| `clutch` | `inputs.clutch` |
| `handBrake` | `brakes.hand-brake` |
| `weather` | at least one real weather semantic; list every advertised weather channel as required or optional |
| `pitStatus` | game-selected `race.pit-status` or `race.on-pit-road` |

Analysis binding decisions:

| Contract | FM 2023 | F1 2025 | ACC | AC Evo | iRacing |
|---|---|---|---|---|---|
| `balance` | yaw-only derivation | physical-angle hybrid derivation | physical-angle hybrid derivation | physical-angle hybrid derivation | yaw-only derivation |
| `gForce` | acceleration derivation | acceleration derivation | acceleration derivation | acceleration derivation | acceleration derivation |
| `gripDemand` | source-native `tires.tire-combined-slip` strategy | friction-circle derivation | friction-circle derivation | friction-circle derivation | unavailable |
| `traction` | unavailable: source-normalized slip has no calibrated lock/spin model | physical slip/wheel strategy | physical slip/wheel strategy | physical slip/wheel strategy | unavailable |
| `tireTemperature` | `tire.temperature.average` | same | same | same | same, pit snapshot |
| `surface` | per-wheel rumble/puddle bindings | unavailable | unavailable | unavailable | vehicle `identity.player-track-surface` |
| `slipRatio` | `tires.tire-slip-ratio`, documented source-normalized | physical ratio | physical ratio | physical ratio | unavailable |
| `slipAngle` | unavailable | `tires.tire-slip-angle` | same | same | unavailable |
| `lateralSlip` | `tires.normalized-tire-slip-angle` | unavailable | unavailable | unavailable | unavailable |
| `wheelRotation` | `tires.wheel-rotation-speed` | same | same | same | unavailable |
| `tireHealth` | `tires.tire-wear` | same | same | same | same, pit snapshot |
| `tireWearRate` | tire-wear time derivation | same | same | same | unavailable |
| `tirePressure` | unavailable | `tires.tire-pressure` | same | same | same, static cold pressure |
| `suspensionTravel` | `suspension.norm-suspension-travel` | `suspension.suspension-travel-m` | normalized travel | millimeter travel | millimeter travel |
| `suspensionCompressionBias` | normalized-travel derivation | unavailable | normalized-travel derivation | normalized-travel derivation | unavailable |

---

### Task 1: Restore deterministic catalog baseline

**Files:**
- Regenerate `shared/telemetry/catalog/generated/telemetry-catalog.generated.json`
- Regenerate `shared/telemetry/catalog/generated/telemetry-catalog.generated.ts`
- Regenerate `shared/telemetry/catalog/generated/telemetry-catalog.types.ts`
- Regenerate `shared/telemetry/catalog/generated/TELEMETRY_CATALOG.md`
- Regenerate `shared/telemetry/catalog/generated/telemetry-catalog-matrix.md`
- Inspect generator sources under `scripts/catalog/`

**Interfaces:**
- Consumes: `buildTelemetryCatalogArtifacts(): Promise<Map<string, string>>`
- Produces: deterministic generated artifacts accepted by `telemetry:catalog:check`

- [ ] **Step 1: Reproduce current stale-artifact failure**

Run:

```bash
bun run telemetry:catalog:check
```

Expected current result: FAIL naming `shared/telemetry/catalog/generated/telemetry-catalog.generated.json` as stale.

- [ ] **Step 2: Generate all artifacts from current source contracts**

Run:

```bash
bun run telemetry:catalog
```

Expected: generator writes all five artifacts and reports semantic-variable and source-link counts.

- [ ] **Step 3: Classify generated changes before contract edits**

Review only the five generated files. For each changed mapping, identify its source declaration in `scripts/catalog/semantic-definitions*.ts`, `packet-mapping.ts`, `extension-mapping.ts`, `iracing-mapping.ts`, or `derived-projections.ts`. Reject generated output that silently changes canonical unit, shape, source path, or availability without a matching source declaration.

- [ ] **Step 4: Prove determinism**

Run twice through the existing repeat check:

```bash
bun run telemetry:catalog:check
```

Expected: PASS with identical second-generation content.

- [ ] **Step 5: Commit baseline separately**

```bash
git add shared/telemetry/catalog/generated
git commit -m "chore: refresh telemetry catalog"
```

---

### Task 2: Add typed semantic bindings and catalog validator

**Files:**
- Create `shared/games/metric-contracts.ts`
- Create `test/telemetry/game-metric-contracts.test.ts`

**Interfaces:**
- Produces:

```ts
export type SemanticValueBinding = {
  kind: "value";
  semanticId: TelemetryVariableId;
};

export type SemanticDerivationBinding = {
  kind: "derived";
  derivation: "g-force-v1" | "friction-circle-v1" | "physical-balance-v1" | "yaw-balance-v1" | "traction-v1" | "wear-rate-v1" | "compression-bias-v1";
  requires: readonly TelemetryVariableId[];
};

export type SemanticGroupBinding = {
  kind: "group";
  required: readonly TelemetryVariableId[];
  optional?: readonly TelemetryVariableId[];
};

export type SemanticMetricBinding = SemanticValueBinding | SemanticDerivationBinding | SemanticGroupBinding;

export function assertSemanticBinding(
  gameId: GameId,
  metric: string,
  binding: SemanticMetricBinding,
  catalog: TelemetryCatalogData,
  presentation?: { display?: "per-wheel" | "vehicle"; freshness?: "continuous" | "pit-snapshot" | "static" },
): void;
```

- [ ] **Step 1: Write failing catalog-binding tests**

```ts
import { describe, expect, test } from "bun:test";
import { assertSemanticBinding } from "../../shared/games/metric-contracts";
import { TELEMETRY_CATALOG } from "../../shared/telemetry/catalog/data";

describe("semantic metric bindings", () => {
  test("accepts Forza normalized lateral slip", () => {
    expect(() =>
      assertSemanticBinding(
        "fm-2023",
        "lateralSlip",
        { kind: "value", semanticId: "tires.normalized-tire-slip-angle" },
        TELEMETRY_CATALOG,
        { display: "per-wheel", freshness: "continuous" },
      ),
    ).not.toThrow();
  });

  test("rejects unavailable Forza physical slip angle", () => {
    expect(() =>
      assertSemanticBinding(
        "fm-2023",
        "slipAngle",
        { kind: "value", semanticId: "tires.tire-slip-angle" },
        TELEMETRY_CATALOG,
        { display: "per-wheel", freshness: "continuous" },
      ),
    ).toThrow("fm-2023.slipAngle: tires.tire-slip-angle is unavailable");
  });
});
```

- [ ] **Step 2: Run tests and confirm contract API is absent**

```bash
bun test test/telemetry/game-metric-contracts.test.ts
```

Expected: FAIL because `metric-contracts` does not exist.

- [ ] **Step 3: Implement pure binding validation**

For every value or group binding, require catalog mapping kind other than `unavailable`. For every derivation input, require an available mapping. Require per-wheel displays to bind fixed cardinality four ordered `FL,FR,RL,RR`; vehicle displays must bind scalar values. Compare declared freshness to mapping freshness. Include game ID, contract key, and semantic ID in every thrown error.

Core lookup behavior:

```ts
const variable = catalog.variables.find(({ id }) => id === semanticId);
if (!variable) throw new Error(`${gameId}.${metric}: unknown semantic ${semanticId}`);
const mapping = variable.games[gameId];
if (!mapping || mapping.kind === "unavailable") {
  throw new Error(`${gameId}.${metric}: ${semanticId} is unavailable`);
}
```

- [ ] **Step 4: Add negative validator tests**

Assert exact failures for unknown semantic ID, unavailable game mapping, per-wheel/scalar mismatch, freshness mismatch, and unavailable derived input. Tests mutate binding/presentation input only; they never inspect source text.

- [ ] **Step 5: Run validator tests**

```bash
bun test test/telemetry/game-metric-contracts.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit validator primitive**

```bash
git add shared/games/metric-contracts.ts test/telemetry/game-metric-contracts.test.ts
git commit -m "feat: validate game metric semantics"
```

---

### Task 3: Correct all five adapter contracts and semantic definitions

**Files:**
- Modify `shared/games/types.ts`
- Modify `shared/games/metric-contracts.ts`
- Modify `shared/games/fm-2023/index.ts`
- Modify `shared/games/f1-2025/index.ts`
- Modify `shared/games/acc/index.ts`
- Modify `shared/games/ac-evo/index.ts`
- Modify `shared/games/iracing/index.ts`
- Modify `shared/racing/analysis/telemetry-capabilities.ts`
- Modify `server/games/fm-2023/parser.ts` comments only where normalized fields are mislabeled
- Modify `shared/telemetry/types.ts` comments only where normalized fields are mislabeled
- No catalog generator-source changes expected; Task 1's regenerated mappings are the baseline for adapter correction
- Test `test/telemetry/game-metric-contracts.test.ts`
- Test `test/telemetry/analysis-telemetry.test.ts`
- Test `test/telemetry/telemetry-model.test.ts`

**Interfaces:**
- Consumes: binding types and `assertSemanticBinding` from Task 2
- Produces:

```ts
export function assertGameMetricContracts(
  adapters: readonly GameAdapter[],
  catalog: TelemetryCatalogData,
): void;

export function requiredSemanticIds(adapter: GameAdapter): readonly TelemetryVariableId[];
```

- [ ] **Step 1: Integrate bindings into adapter types and replace permissive defaults**

Add `binding: SemanticMetricBinding` to every available scalar/channel/group spec. Replace analysis `source: "direct"` with `source: "semantic"` plus a value binding; retain `source: "derived"` with a derivation binding; unavailable metrics retain reason and carry no binding. Add `lateralSlip` to `AnalysisTelemetryModel`. Keep shared defaults only where binding and calculation strategy are identical across all supported games; move physical slip, surface, pressure, suspension, compression bias, Grip Ask, and traction into explicit per-game overrides.

- [ ] **Step 2: Correct Forza semantics without fake radians**

Bind `lateralSlip` to `tires.normalized-tire-slip-angle`; mark physical `slipAngle` and traction unavailable. Bind `balance` to `yaw-balance-v1` requiring `motion.speed`, `motion.acceleration-x`, and `motion.angular-velocity-y`; never use normalized lateral slip as a physical angle. Bind `gripDemand` directly to `tires.tire-combined-slip`. Keep `slipRatio` available but mark presentation/source copy as source-normalized. Mark tire pressure unavailable. Update parser/type comments from “tire slip angle” to “source-normalized lateral-slip signal”; packet field names remain unchanged for recording compatibility.

- [ ] **Step 3: Correct F1 suspension and compression contracts**

Bind suspension display to `suspension.suspension-travel-m` with millimeter presentation. Mark compression bias unavailable because `suspension.norm-suspension-travel` is unavailable. Keep physical slip angle, friction-circle Grip Ask, wheel rotation, tire pressure, brake temperature, weather, and ERS available.

- [ ] **Step 4: Correct ACC and AC Evo differences**

Keep ACC physical slip and normalized suspension bindings; surface stays unavailable. Keep AC Evo physical slip and millimeter suspension display, mark surface unavailable because neither per-wheel nor vehicle surface semantic resolves, and bind compression bias to its available derived `suspension.norm-suspension-travel` mapping.

- [ ] **Step 5: Correct iRacing grouped bindings**

Bind pit status to `race.on-pit-road`, not unavailable `race.pit-status`. Preserve pit-snapshot tire temperature/health and static cold pressure. Mark physical slip, Grip Ask, traction, wear rate, wheel rotation, and normalized compression bias unavailable. Bind `balance` to `yaw-balance-v1` using speed, lateral acceleration, and yaw rate.

- [ ] **Step 6: Add exhaustive all-game contract assertions**

Add the all-adapter validator test:

```ts
initGameAdapters();

test("every advertised capability resolves against catalog", () => {
  const adapters = KNOWN_GAME_IDS.map(getGame);
  expect(() => assertGameMetricContracts(adapters, TELEMETRY_CATALOG)).not.toThrow();
});
```

Assert the status table from Contract Inventory for every analysis metric/game pair. In `telemetry-model.test.ts`, retain the existing top-level matrix and add assertions that every present field has the expected semantic ID or group binding.

- [ ] **Step 7: Run focused tests and catalog validation**

```bash
bun test test/telemetry/game-metric-contracts.test.ts test/telemetry/analysis-telemetry.test.ts test/telemetry/telemetry-model.test.ts
bun run telemetry:catalog:check
```

Expected: all pass; no adapter advertises unavailable semantic input.

- [ ] **Step 8: Commit corrected contracts**

```bash
git add shared/games shared/racing/analysis/telemetry-capabilities.ts shared/telemetry/types.ts server/games/fm-2023/parser.ts test/telemetry
git commit -m "fix: align game metrics with telemetry catalog"
```

---

### Task 4: Make Analyse and live consumers use contract bindings

**Files:**
- Create `shared/racing/analysis/metric-values.ts`
- Modify `shared/racing/analysis/laps/physics/vehicle.ts`
- Modify `client/src/components/analyse/AnalyseDynamicsPanel.tsx`
- Modify `client/src/components/analyse/AnalyseSuspensionPanel.tsx`
- Modify `client/src/components/analyse/AnalyseTireWheelsPanel.tsx`
- Modify `client/src/components/telemetry/TelemetryCharts.tsx`
- Modify `client/src/components/telemetry/TireDiagram.tsx`
- Modify `client/src/components/telemetry/GripHistory.tsx`
- Modify `client/src/components/analyse/DataGuideModal.tsx`
- Modify `client/messages/en.json` and translated message catalogs for changed labels/copy
- Create `test/telemetry/analysis-metric-values.test.ts`
- Modify `client/test/telemetry-capabilities-ui.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SemanticMetricFrame {
  readonly values: Readonly<Record<string, unknown>>;
}

export function resolveWheelMetric(
  frame: SemanticMetricFrame,
  binding: SemanticValueBinding,
): readonly [number | null, number | null, number | null, number | null];

export function resolveGripDemand(
  frame: SemanticMetricFrame,
  metric: AnalysisTelemetryMetric,
): readonly [number | null, number | null, number | null, number | null];

export function resolveWheelStates(
  frame: SemanticMetricFrame,
  metric: AnalysisTelemetryMetric,
): readonly [WheelState | null, WheelState | null, WheelState | null, WheelState | null];

export function resolveBalance(
  frame: SemanticMetricFrame,
  metric: AnalysisTelemetryMetric,
): SteerBalance | null;
```

- [ ] **Step 1: Write failing pure resolver tests**

Cover: Forza combined slip `[0.72, 0.75, 1.08, 1.12]` resolves unchanged as Grip Ask values; F1/ACC/AC Evo physical ratio/angle inputs use `frictionCircleUtil`; FM/iRacing yaw-only balance classifies representative understeer, oversteer, neutral, and low-load frames without slip angles; missing required input returns null values; unavailable metrics return null values; Forza normalized lateral slip never receives radians-to-degrees conversion or enters balance calculation.

- [ ] **Step 2: Run tests and confirm failure**

```bash
bun test test/telemetry/analysis-metric-values.test.ts
```

Expected: FAIL because resolver module does not exist.

- [ ] **Step 3: Implement binding-driven pure resolvers**

Switch only on declared binding kind and derivation ID. Never infer a fallback semantic ID. A semantic Grip Ask binding reads its declared per-wheel value unchanged; `friction-circle-v1` requires physical `tires.tire-slip-ratio` plus `tires.tire-slip-angle`; `traction-v1` classifies physical lock/spin/grip state from those same signed ratio/angle channels without an assumed tire radius. `physical-balance-v1` uses yaw plus physical slip angles; `yaw-balance-v1` uses only speed, lateral acceleration, and yaw rate and reports `slipAvailable: false`. Return null for unavailable metrics or missing/non-finite required inputs.

- [ ] **Step 4: Migrate dynamics presentation**

`AnalyseDynamicsPanel` must resolve Grip Ask, physical slip angle, normalized lateral slip, traction, and balance through the selected game contract. Render `Angle` in degrees only for physical `slipAngle`; render a separately labeled `Lateral slip` ratio for Forza. Label FM/iRacing balance as yaw-only. Do not feed normalized lateral slip into `steerBalanceFromSignals` or `frictionCircleUtil`.

- [ ] **Step 5: Migrate suspension, tire, chart, and live visibility**

Use bound semantic IDs for suspension mode, pressure, temperature, wear, wheel rotation, Grip Ask, slip rows, and chart visibility. Remove capability checks that say “available” without resolving their declared semantic binding. Preserve explicit unavailable cells and pit/static freshness captions.

- [ ] **Step 6: Correct user-facing formulas and limitations**

Update Data Guide copy: physical friction-circle formula applies only where physical slip angle is available; Forza Grip Ask is source-native combined slip; Forza lateral slip is dimensionless and not degrees. Remove the existing claim that physical slip angle is radians in FM/F1/ACC from `vehicle.ts`.

- [ ] **Step 7: Add UI contract assertions**

Render semantic frames directly. Assert Forza shows populated Grip Ask, `Lateral slip`, and yaw-only Balance; it must not show a degree symbol for lateral slip or fabricate slip-angle detail in Balance. Assert F1 suspension shows millimeters. Assert AC Evo omits surface. Assert iRacing shows yaw-only Balance, retains snapshot/static captions, and hides continuous slip charts.

- [ ] **Step 8: Run focused pure and UI tests**

```bash
bun test test/telemetry/analysis-metric-values.test.ts client/test/telemetry-capabilities-ui.test.ts client/test/live-telemetry-view.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit consumer migration**

```bash
git add shared/racing/analysis client/src/components client/messages test/telemetry/analysis-metric-values.test.ts client/test
git commit -m "fix: resolve telemetry UI from metric contracts"
```

---

### Task 5: Enforce bindings through replay and native recordings

**Files:**
- Modify `test/support/telemetry/catalog-e2e.ts`
- Modify all five `test/telemetry/catalog/telemetry-catalog-*-e2e.test.ts`
- Modify `server/routes/laps/resource-routes.ts`
- Modify `playwright/tests/seeded/analyse/telemetry.spec.ts`

**Interfaces:**
- Consumes: `requiredSemanticIds(adapter)` from Task 2
- Produces: native-fixture proof that every advertised continuous metric resolves through production parser, catalog, replay, and Analyse UI

- [ ] **Step 1: Extend recording coverage input**

Add:

```ts
export interface RecordedCatalogCoverage {
  // existing fields remain
  requiredSemanticIds?: readonly string[];
}
```

Compile the union of explicit expectations and `requiredSemanticIds`. For required IDs without custom range predicates, accept any resolver result with state `ok` and a finite scalar/per-wheel numeric value. Exclude `pit-snapshot` contracts from continuous-lap requirements; test those with existing snapshot fixtures.

- [ ] **Step 2: Derive each game’s required continuous semantics**

Each catalog E2E test calls `requiredSemanticIds(getGame(gameId))` and passes the result to `assertRecordedCatalogCoverage`. Keep existing dynamic-range assertions for speed, controls, timing, and representative tire/suspension channels.

- [ ] **Step 3: Add Forza-specific semantic expectations**

Require `tires.normalized-tire-slip-angle`, `tires.tire-combined-slip`, `tires.tire-slip-ratio`, and `tires.wheel-rotation-speed` to resolve and vary on the committed FM recording. Assert `tires.tire-slip-angle` remains unavailable; this prevents normalized source data from being relabeled as radians.

- [ ] **Step 4: Confirm replay request completeness**

Replace the broad packet-field heuristic in `semanticReplayIds` with the union of `requiredSemanticIds(adapter)` for all registered games plus explicitly consumed non-metric replay IDs (`brakes.brake-bias`, position, timing, weather, ERS, and track-map inputs). Add a unit assertion that every bound value and derivation input appears in the replay request set.

- [ ] **Step 5: Add seeded browser metric matrix**

Extend `telemetry.spec.ts` with game-specific rows:

```ts
const GAME_METRIC_ROWS = {
  "fm-2023": ["Grip Ask", "Lateral slip", "Balance"],
  "f1-2025": ["Grip Ask", "Angle", "Suspension", "Balance"],
  acc: ["Grip Ask", "Angle", "Suspension", "Balance"],
  "ac-evo": ["Grip Ask", "Angle", "Suspension", "Balance"],
  iracing: ["Suspension", "Balance"],
} as const;
```

For each advertised row, seek two frames whose bound source values differ and assert rendered row text differs and is not `—`. Add assertions that FM/iRacing Balance is labeled yaw-only and contains no slip-angle detail, plus negative assertions for Forza physical degrees, AC Evo surface, and iRacing slip rows.

- [ ] **Step 6: Run per-game native fixture tests**

```bash
bun test test/telemetry/catalog/telemetry-catalog-fm-2023-e2e.test.ts test/telemetry/catalog/telemetry-catalog-f1-2025-e2e.test.ts test/telemetry/catalog/telemetry-catalog-acc-e2e.test.ts test/telemetry/catalog/telemetry-catalog-ac-evo-e2e.test.ts test/telemetry/catalog/telemetry-catalog-iracing-e2e.test.ts --timeout 120000
```

Expected: all five pass.

- [ ] **Step 7: Run seeded Analyse browser proof**

```bash
cd playwright && PW_SERVER_SET=seeded bunx playwright test tests/seeded/analyse/telemetry.spec.ts --project=seeded-e2e --max-failures=1
```

Expected: all game metric rows populate according to contracts; no browser errors.

- [ ] **Step 8: Commit end-to-end enforcement**

```bash
git add test/support/telemetry test/telemetry/catalog server/routes/laps/resource-routes.ts playwright/tests/seeded/analyse/telemetry.spec.ts
git commit -m "test: enforce game metric semantic coverage"
```

---

### Task 6: Final verification and release artifact

**Files:**
- Modify `CHANGELOG.md` under `Unreleased` because Forza Analyse gains visible Grip Ask and normalized lateral-slip output, FM/iRacing gain yaw-only Balance, and false metrics are removed from unsupported games
- No other source changes expected

**Interfaces:**
- Consumes: completed Tasks 1–5
- Produces: release-ready verified change set

- [ ] **Step 1: Run catalog and focused contract suite**

```bash
bun run telemetry:catalog:check
bun test test/telemetry/game-metric-contracts.test.ts test/telemetry/analysis-telemetry.test.ts test/telemetry/telemetry-model.test.ts test/telemetry/analysis-metric-values.test.ts client/test/telemetry-capabilities-ui.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run complete telemetry tests**

```bash
bun test test/telemetry --timeout 120000
```

Expected: PASS.

- [ ] **Step 3: Run static verification**

```bash
bun run typecheck
bun run build
```

Expected: both PASS.

- [ ] **Step 4: Repeat seeded browser smoke after build**

Run Analyse telemetry and cross-game specs under seeded server. Expected: all five games load, advertised rows populate, unsupported rows remain absent/unavailable, and browser error collection is empty.

- [ ] **Step 5: Record release note**

Add one concise `Unreleased` entry: Forza Analyse now uses source-native combined slip for Grip Ask and labels normalized lateral slip accurately; FM/iRacing expose yaw-only Balance; telemetry panels no longer advertise metrics missing canonical semantic inputs.

- [ ] **Step 6: Commit verification artifact**

```bash
git add CHANGELOG.md
git commit -m "docs: note metric contract corrections"
```
