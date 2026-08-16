/**
 * Pure/query-level tests for the Setup Engineer tools' grounding mechanism
 * (docs/architecture/setup-engineer.md).
 *
 * Deliberately does NOT import the composed app (server/index.ts) or
 * `mastra/tools/setup-engineer.ts` itself — the tool file wires DB/fs/memory
 * side effects via `loadActiveExperimentContext`/`writeSetupFile`/`createExperimentVersion`,
 * none of which are worth mocking here. Instead this exercises the same
 * primitives the tools are built on directly:
 *   - `describeKnobs` — what `get_setup` returns.
 *   - `applyIntents` on a clone — what `preview_change` runs (read-only).
 *   - a zod enum built from `knownComponents` — the grounding mechanism that
 *     makes an unlisted component a schema-validation failure, not just a
 *     silently-skipped intent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { RequestContext } from "@mastra/core/request-context";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { eq, inArray } from "drizzle-orm";
import { applyIntents, describeKnobs } from "../../../server/setups/rules/engine";
import { knownComponents } from "../../../server/setups/rules/catalog";
import { readSetupEngineerContext } from "../../../mastra/tools/setup-engineer-request-context";
import { setupEngineerTools } from "../../../mastra/tools/setup-engineer";
import { db } from "../../../server/db";
import { experimentActions, experiments, laps, sessions } from "../../../server/db/schema";
import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  QUALITY_SCHEMA_VERSION,
  type EligibilityDecisionSet,
  type EligibilityPolicyId,
  type QualityReasonCode,
} from "../../../shared/racing/quality/contracts";
import { evaluateAllEligibility } from "../../../shared/racing/quality/policies";
import { QUALITY_REASON_META } from "../../../shared/racing/quality/reasons";
import type { GameId } from "../../../shared/games/ids";
import { qualityPackets, summarize } from "../../support/lap-analysis/quality-model";

function baseAccSetup() {
  return {
    basicSetup: {
      tyres: { tyrePressure: [26, 26, 26, 26] },
    },
    advancedSetup: {
      mechanicalBalance: { aRBFront: 5, aRBRear: 5, brakeBias: 55 },
      aeroBalance: { splitter: 3, rearWing: 4, rideHeight: [65, 65, 75, 75] },
      dampers: { bumpSlow: [8, 8, 8, 8], reboundSlow: [8, 8, 8, 8] },
      drivetrain: { preload: 40 },
    },
  };
}

describe("describeKnobs — get_setup grounding", () => {
  test("returns every known component with current value, range, and step", () => {
    const setup = baseAccSetup();
    const knobs = describeKnobs("acc", setup);
    const names = knobs.map((k) => k.component);

    expect(names.sort()).toEqual(knownComponents("acc").sort());

    const arb = knobs.find((k) => k.component === "Front Anti-Roll Bar")!;
    expect(arb.current).toBe(5);
    expect(arb.min).toBe(0);
    expect(arb.max).toBe(30);
    expect(arb.step).toEqual({ small: 1, medium: 2, large: 4 });

    const preload = knobs.find((k) => k.component === "Diff Preload")!;
    expect(preload.current).toBe(40);
    expect(preload.step.medium).toBe(2);
  });

  test("returns [] for a game with no rules table", () => {
    // "gt7" has no entry in setup rule catalog.
    expect(describeKnobs("gt7" as any, {})).toEqual([]);
  });

  test("f1-2025 has a RULES table sourced from the catalog (Phase 10)", () => {
    const knobs = describeKnobs("f1-2025", {});
    const names = knobs.map((k) => k.component);
    expect(names.sort()).toEqual(knownComponents("f1-2025").sort());

    const wing = knobs.find((k) => k.component === "Front Wing")!;
    expect(wing.min).toBe(0);
    expect(wing.max).toBe(50);
    expect(wing.current).toBeNull();
  });

  test("current is null when the setup is missing the field", () => {
    const knobs = describeKnobs("acc", {});
    const arb = knobs.find((k) => k.component === "Front Anti-Roll Bar")!;
    expect(arb.current).toBeNull();
  });
});

describe("preview_change semantics — applyIntents on a clone, never mutating the input", () => {
  test("returns the real clamped resulting value without touching the source setup", () => {
    const setup = baseAccSetup();
    const { applied, skipped } = applyIntents("acc", setup, [{ component: "Front Anti-Roll Bar", direction: "increase", magnitude: "medium", reason: "preview" }]);

    expect(skipped).toHaveLength(0);
    expect(applied[0]!.from).toBe(5);
    expect(applied[0]!.to).toBe(7);
    // Source object passed in is untouched — preview_change must never persist.
    expect(setup.advancedSetup.mechanicalBalance.aRBFront).toBe(5);
  });

  test("reports noop with a reason when the knob is already at its clamp limit", () => {
    const setup = baseAccSetup();
    setup.advancedSetup.mechanicalBalance.aRBFront = 30; // at max
    const { applied, skipped } = applyIntents("acc", setup, [{ component: "Front Anti-Roll Bar", direction: "increase", magnitude: "small", reason: "preview" }]);

    expect(applied).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toMatch(/clamp/i);
  });
});

describe("component grounding — the engine is the guard, not the schema", () => {
  // preview_change / apply_changes now accept `component: z.string()` (a static
  // tool's schema can't vary per game). The deterministic engine — applyIntents
  // — is what rejects an unknown component: it lands in `skipped` with a reason
  // and is never applied. This is the contract that replaced the per-game enum.
  test("a known component is applied", () => {
    const { applied, skipped } = applyIntents("acc", baseAccSetup(), [{ component: "Diff Preload", direction: "increase", magnitude: "small", reason: "t" }]);
    expect(applied.map((a) => a.component)).toContain("Diff Preload");
    expect(skipped.map((s) => s.component)).not.toContain("Diff Preload");
  });

  test("an unknown/hallucinated component is skipped with a reason, never applied", () => {
    const { applied, skipped } = applyIntents("acc", baseAccSetup(), [{ component: "Front Anti-Roll Bar Stiffness Coefficient", direction: "increase", magnitude: "small", reason: "t" }]);
    expect(applied).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBeTruthy();
  });
});

describe("readSetupEngineerContext — per-request gameId/sessionId guard", () => {
  const ctx = (entries: Record<string, unknown>) => ({ get: (k: string) => entries[k] });

  test("returns { gameId, sessionId } from a Map-like request context", () => {
    expect(readSetupEngineerContext(ctx({ gameId: "acc", sessionId: 61 }))).toEqual({
      gameId: "acc",
      sessionId: 61,
    });
  });

  test("throws when the context is missing", () => {
    expect(() => readSetupEngineerContext(undefined)).toThrow(/requestContext/);
  });

  test("throws when sessionId is absent or not a number", () => {
    expect(() => readSetupEngineerContext(ctx({ gameId: "acc" }))).toThrow();
    expect(() => readSetupEngineerContext(ctx({ gameId: "acc", sessionId: "61" }))).toThrow();
  });

  test("throws when gameId is absent", () => {
    expect(() => readSetupEngineerContext(ctx({ sessionId: 61 }))).toThrow();
  });
});

const createdScopeExperimentIds: number[] = [];
const createdScopeSessionIds: number[] = [];
const scopeQuality = summarize(qualityPackets(200));

function scopeEligibility(rejectedPolicy?: EligibilityPolicyId, reason: QualityReasonCode = "traffic_context"): EligibilityDecisionSet {
  const eligibility = structuredClone(evaluateAllEligibility(scopeQuality));
  for (const policyId of ["corner-trace", "tire-analysis", "lap-comparison"] as const) {
    eligibility[policyId] = {
      ...eligibility[policyId],
      status: policyId === rejectedPolicy ? "ineligible" : "eligible",
      confidence: { level: "high", score: 1 },
      reasons: policyId === rejectedPolicy ? [{ code: reason, severity: QUALITY_REASON_META[reason].defaultSeverity, evidenceIds: [], semanticIds: [], timeRange: null, distanceRange: null }] : [],
      evidenceIds: [],
    };
  }
  return eligibility;
}

function toolContext(gameId: GameId, sessionId: number): RequestContext {
  const requestContext = new RequestContext();
  requestContext.set("gameId", gameId);
  requestContext.set("sessionId", sessionId);
  return requestContext;
}

function toolExecutionContext(requestContext: RequestContext): ToolExecutionContext<unknown, unknown, unknown> {
  return { requestContext } as ToolExecutionContext<unknown, unknown, unknown>;
}

async function insertScopeExperiment(gameId: GameId, trackOrdinal: number): Promise<number> {
  const row = await db
    .insert(experiments)
    .values({ gameId, name: `scope ${createdScopeExperimentIds.length}`, trackOrdinal })
    .returning({ id: experiments.id })
    .get();
  createdScopeExperimentIds.push(row.id);
  return row.id;
}

async function insertScopeSession(gameId: GameId, trackOrdinal: number, ownership: "mine" | "others" = "mine"): Promise<number> {
  const row = await db.insert(sessions).values({ gameId, carOrdinal: 9_302_000, trackOrdinal, ownership }).returning({ id: sessions.id }).get();
  createdScopeSessionIds.push(row.id);
  return row.id;
}

async function insertScopeLap(sessionId: number, experimentId: number, lapNumber: number, eligibility: EligibilityDecisionSet): Promise<number> {
  const row = await db
    .insert(laps)
    .values({
      sessionId,
      experimentId,
      lapNumber,
      lapTime: 90_000 + lapNumber,
      isValid: true,
      quality: scopeQuality,
      eligibility,
      qualityGeneration: scopeQuality.provenance.outputGeneration,
      qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
      qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
      qualityConfigVersion: QUALITY_CONFIG_VERSION,
    })
    .returning({ id: laps.id })
    .get();
  return row.id;
}

afterEach(async () => {
  if (createdScopeExperimentIds.length > 0) {
    await db.delete(experimentActions).where(inArray(experimentActions.experimentId, createdScopeExperimentIds)).run();
  }
  if (createdScopeSessionIds.length > 0) {
    await db.delete(laps).where(inArray(laps.sessionId, createdScopeSessionIds)).run();
    await db.delete(sessions).where(inArray(sessions.id, createdScopeSessionIds)).run();
    createdScopeSessionIds.length = 0;
  }
  if (createdScopeExperimentIds.length > 0) {
    await db.delete(experiments).where(inArray(experiments.id, createdScopeExperimentIds)).run();
    createdScopeExperimentIds.length = 0;
  }
});

describe("Setup Engineer explicit lap scope", () => {
  test("rejects wrong game, experiment, track, and ownership before mutation", async () => {
    const experimentId = await insertScopeExperiment("iracing", 9_302_001);
    const otherExperimentId = await insertScopeExperiment("iracing", 9_302_001);
    const ownedSessionId = await insertScopeSession("iracing", 9_302_001);
    const wrongTrackSessionId = await insertScopeSession("iracing", 9_302_002);
    const otherOwnedSessionId = await insertScopeSession("iracing", 9_302_001, "others");
    const ownedLapId = await insertScopeLap(ownedSessionId, experimentId, 1, scopeEligibility());
    const wrongTrackLapId = await insertScopeLap(wrongTrackSessionId, experimentId, 2, scopeEligibility());
    const otherOwnedLapId = await insertScopeLap(otherOwnedSessionId, experimentId, 3, scopeEligibility());

    expect(await setupEngineerTools.getLapDetailTool.execute!({ lapId: ownedLapId }, toolExecutionContext(toolContext("acc", experimentId)))).toMatchObject({ ok: false });
    expect(await setupEngineerTools.getLapDetailTool.execute!({ lapId: ownedLapId }, toolExecutionContext(toolContext("iracing", otherExperimentId)))).toMatchObject({ ok: false });
    expect(await setupEngineerTools.getLapDetailTool.execute!({ lapId: wrongTrackLapId }, toolExecutionContext(toolContext("iracing", experimentId)))).toMatchObject({ ok: false });
    expect(await setupEngineerTools.getLapDetailTool.execute!({ lapId: otherOwnedLapId }, toolExecutionContext(toolContext("iracing", experimentId)))).toMatchObject({ ok: false });

    const mutation = await setupEngineerTools.setLapExcludedTool.execute!({ lapId: otherOwnedLapId, excluded: true }, toolExecutionContext(toolContext("iracing", experimentId)));
    expect(mutation).toMatchObject({ ok: false });
    expect(await db.select({ excluded: laps.experimentExcluded, source: laps.experimentExcludedSource }).from(laps).where(eq(laps.id, otherOwnedLapId)).get()).toEqual({
      excluded: null,
      source: null,
    });
    expect(await db.select({ id: experimentActions.id }).from(experimentActions).where(eq(experimentActions.experimentId, experimentId)).all()).toHaveLength(0);
  });

  test("enforces detail policies and both comparison inputs within same track", async () => {
    const experimentId = await insertScopeExperiment("iracing", 9_302_011);
    const sessionId = await insertScopeSession("iracing", 9_302_011);
    const wrongTrackSessionId = await insertScopeSession("iracing", 9_302_012);
    const cornerRejectedId = await insertScopeLap(sessionId, experimentId, 1, scopeEligibility("corner-trace"));
    const tireRejectedId = await insertScopeLap(sessionId, experimentId, 2, scopeEligibility("tire-analysis"));
    const compareEligibleId = await insertScopeLap(sessionId, experimentId, 3, scopeEligibility());
    const compareRejectedId = await insertScopeLap(sessionId, experimentId, 4, scopeEligibility("lap-comparison"));
    const wrongTrackId = await insertScopeLap(wrongTrackSessionId, experimentId, 5, scopeEligibility());
    const requestContext = toolContext("iracing", experimentId);

    const cornerRejected = await setupEngineerTools.getLapDetailTool.execute!({ lapId: cornerRejectedId }, toolExecutionContext(requestContext));
    expect(cornerRejected).toMatchObject({ ok: false, eligibilityStatus: "ineligible", reasonCodes: ["traffic_context"] });
    const tireRejected = await setupEngineerTools.getLapDetailTool.execute!({ lapId: tireRejectedId }, toolExecutionContext(requestContext));
    expect(tireRejected).toMatchObject({ ok: false, eligibilityStatus: "ineligible", reasonCodes: ["traffic_context"] });

    const rejectedA = await setupEngineerTools.compareLapsTool.execute!({ lapId1: compareRejectedId, lapId2: compareEligibleId }, toolExecutionContext(requestContext));
    expect(rejectedA).toMatchObject({ ok: false, eligibilityStatus: "ineligible", reasonCodes: ["traffic_context"] });
    const rejectedB = await setupEngineerTools.compareLapsTool.execute!({ lapId1: compareEligibleId, lapId2: compareRejectedId }, toolExecutionContext(requestContext));
    expect(rejectedB).toMatchObject({ ok: false, eligibilityStatus: "ineligible", reasonCodes: ["traffic_context"] });
    expect(await setupEngineerTools.compareLapsTool.execute!({ lapId1: compareEligibleId, lapId2: wrongTrackId }, toolExecutionContext(requestContext))).toMatchObject({ ok: false });
  });
});
