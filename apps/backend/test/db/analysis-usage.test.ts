import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { sessions, laps, driverProfiles, driverProfileRuns } from "@raceiq/backend-core/db/schema";
import { getAnalysis, saveAnalysis, getCompareAnalysis, saveCompareAnalysis } from "@raceiq/backend-core/db/analysis-queries";
import { createDriverProfileRun, getDriverProfileRun, saveDriverProfile, driverProfileScopeKey } from "@raceiq/backend-core/db/driver-profile-queries";
import { comparisonRoutes } from "../../src/routes/laps/comparison-routes";
import { analysisGenerationKey } from "../../src/ai/analysis-generation-key";
import { loadSettings } from "@raceiq/backend-core/runtime/config/settings";
import { getCompareAnalysisTool } from "../../src/mastra/tools/compare-analysis";

test("comparison cache respects displayed lap order", async () => {
  const session = await db.insert(sessions).values({ gameId: "f1-2025", carId: "476", trackId: "19" }).returning({ id: sessions.id }).get();
  try {
    const pair = await db.insert(laps).values([1, 2].map(lapNumber => ({ sessionId: session.id, lapNumber, lapTime: 90, isValid: true }))).returning({ id: laps.id }).all();
    const [a, b] = pair.map(row => row.id);
    const key = analysisGenerationKey("compare", loadSettings(), [a, b]);
    const analysis = JSON.stringify({ verdict: "A is faster", segments: [{ name: "T1", deltaSeconds: -0.2, throttle: "A earlier", brake: "Similar", steering: "Similar", action: "Apply throttle 10m earlier", severity: "moderate" }], coaching: [] });
    await saveCompareAnalysis(a, b, analysis, { inputTokens: null, outputTokens: null, costUsd: null, durationMs: null, model: "fixture" }, "inputs", key);
    const forward = await comparisonRoutes.request(`/api/laps/${a}/compare/${b}/inputs-analyse?cacheOnly=true`, { method: "POST" });
    expect(await forward.json()).toMatchObject({ analysis, cached: true });
    const reversed = await comparisonRoutes.request(`/api/laps/${b}/compare/${a}/inputs-analyse?cacheOnly=true`, { method: "POST" });
    expect(await reversed.json()).toMatchObject({ analysis: null, cached: false });
    expect((await getCompareAnalysis(a, b))?.analysis).toBe(analysis);
    const execute = getCompareAnalysisTool.execute!;
    expect(await execute({ lapAId: a, lapBId: b }, {} as never)).toMatchObject({ available: true });
    expect(await execute({ lapAId: b, lapBId: a }, {} as never)).toMatchObject({ available: false });
  } finally {
    await db.delete(sessions).where(eq(sessions.id, session.id)).run();
  }
});

test("driver profile cache preserves unknown and zero usage when replacing a snapshot", async () => {
  const scope = { gameId: "f1-2025" as const, carId: "usage-contract-fixture", trackId: null };
  const scopeKey = driverProfileScopeKey(scope);
  const unknown = { inputTokens: null, outputTokens: null, costUsd: null, durationMs: null, model: "usage-fixture" };
  const reported = { inputTokens: 0, outputTokens: 42, costUsd: 0, durationMs: 0, model: "reported-fixture" };
  const readUsage = () =>
    db
      .select({
        id: driverProfiles.id,
        inputTokens: driverProfiles.inputTokens,
        outputTokens: driverProfiles.outputTokens,
        costUsd: driverProfiles.costUsd,
        durationMs: driverProfiles.durationMs,
        model: driverProfiles.model,
      })
      .from(driverProfiles)
      .where(eq(driverProfiles.scopeKey, scopeKey))
      .get();
  try {
    await saveDriverProfile(scope, { poolKey: "fixture", fingerprint: "fixture", plan: "{}", usage: unknown });
    const first = await readUsage();
    if (!first) throw new Error("Fixture profile missing");
    expect(first).toMatchObject(unknown);
    await saveDriverProfile(scope, { poolKey: "fixture", fingerprint: "fixture", plan: "{}", usage: reported });
    expect(await readUsage()).toEqual({ id: first.id, ...reported });
    await saveDriverProfile(scope, { poolKey: "fixture", fingerprint: "fixture", plan: "{}", usage: unknown });
    expect(await readUsage()).toEqual({ id: first.id, ...unknown });
  } finally {
    await db.delete(driverProfiles).where(eq(driverProfiles.scopeKey, scopeKey)).run();
  }
});

test("cached lap analysis preserves unreported usage instead of inventing zeros", async () => {
  const session = await db.insert(sessions).values({ gameId: "f1-2025", carId: "476", trackId: "19" }).returning({ id: sessions.id }).get();
  if (!session) throw new Error("Fixture session missing");
  try {
    const lap = await db.insert(laps).values({ sessionId: session.id, lapNumber: 2, lapTime: 79.588, isValid: true }).returning({ id: laps.id }).get();
    if (!lap) throw new Error("Fixture lap missing");
    const usage = { inputTokens: null, outputTokens: null, costUsd: null, durationMs: null, model: "usage-fixture" };
    await saveAnalysis(lap.id, "fixture analysis", usage);
    expect(await getAnalysis(lap.id)).toEqual({ analysis: "fixture analysis", generationKey: null, ...usage });
    const reported = { inputTokens: 123, outputTokens: 0, costUsd: 0, durationMs: 2, model: "reported-fixture" };
    await saveAnalysis(lap.id, "reported analysis", reported, "prompt-version-one");
    expect(await getAnalysis(lap.id)).toEqual({ analysis: "reported analysis", generationKey: "prompt-version-one", ...reported });
    await saveAnalysis(lap.id, "unknown again", usage);
    expect(await getAnalysis(lap.id)).toEqual({ analysis: "unknown again", generationKey: null, ...usage });
  } finally {
    await db.delete(sessions).where(eq(sessions.id, session.id)).run();
  }
});

test("driver profile attempts do not invent usage before any provider response", async () => {
  const id = await createDriverProfileRun({ gameId: "f1-2025", carId: "476", trackId: "19" }, { poolKey: "usage-fixture", inputTokens: null, outputTokens: null, costUsd: null, durationMs: null });
  try {
    expect(await getDriverProfileRun(id)).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null, durationMs: null });
  } finally {
    await db.delete(driverProfileRuns).where(eq(driverProfileRuns.id, id)).run();
  }
});

test("comparison cache preserves unknown usage with canonical lap ordering", async () => {
  const session = await db.insert(sessions).values({ gameId: "f1-2025", carId: "476", trackId: "19" }).returning({ id: sessions.id }).get();
  if (!session) throw new Error("Fixture session missing");
  try {
    const rows = await db
      .insert(laps)
      .values([2, 3].map((lapNumber) => ({ sessionId: session.id, lapNumber, lapTime: 79.588, isValid: true })))
      .returning({ id: laps.id })
      .all();
    const usage = { inputTokens: null, outputTokens: null, costUsd: null, durationMs: null, model: "usage-fixture" };
    await saveCompareAnalysis(rows[1].id, rows[0].id, "comparison fixture", usage);
    expect(await getCompareAnalysis(rows[0].id, rows[1].id)).toEqual({ analysis: "comparison fixture", generationKey: null, ...usage });
    const reported = { inputTokens: 0, outputTokens: 42, costUsd: 0, durationMs: 5, model: "reported-fixture" };
    await saveCompareAnalysis(rows[0].id, rows[1].id, "reported pair", reported, "inputs", "compare-prompt-one");
    expect(await getCompareAnalysis(rows[1].id, rows[0].id)).toEqual({ analysis: "reported pair", generationKey: "compare-prompt-one", ...reported });
  } finally {
    await db.delete(sessions).where(eq(sessions.id, session.id)).run();
  }
});
