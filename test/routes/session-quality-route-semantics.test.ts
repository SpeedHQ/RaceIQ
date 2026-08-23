import { describe, expect, mock, test } from "bun:test";
import { AnalysisGenerationConflictError } from "../../server/db/analysis-receipt-queries";
import type { AnalysisRebuildPreview, AnalysisStatus } from "../../shared/racing/provenance/contracts";
import type { QualityRebuildAction, QualityRebuildStatus } from "../../server/lap-analysis/quality-rebuild";
import { createSessionRoutes, type SessionRouteDependencies } from "../../server/routes/session-routes";

function analysisStatus(status: AnalysisStatus["status"] = "current"): AnalysisStatus {
  return {
    status,
    staleReasons: [],
    activeGeneration: null,
    latestAttempt: null,
    capability: {
      mode: "unavailable",
      sourceKind: "unknown",
      rebuildableArtifacts: [],
      unavailableArtifacts: ["laps", "race_events", "session_runs", "race_result", "quality"],
      limitations: [],
    },
    receipt: null,
    failure: null,
  };
}
function status(sessionId: number, action: QualityRebuildAction): QualityRebuildStatus {
  return {
    sessionId,
    currentDetectorId: action === "unavailable" ? null : "test-detector",
    action,
    rawAvailable: action === "reprocess",
    lapCount: 1,
    recordingQuality: null,
    qualityGeneration: null,
    stale: {
      detector: action !== "current",
      schema: false,
      policy: action === "rebuild_eligibility",
      configuration: false,
      source: false,
    },
    analysisStatus: analysisStatus(action === "unavailable" ? "stale_source_missing" : "current"),
  };
}

function routes(overrides: Partial<SessionRouteDependencies> = {}) {
  return createSessionRoutes({
    sessionExistsForGame: async () => true,
    getQualityRebuildStatus: async (sessionId) => status(sessionId, "current"),
    getAnalysisRebuildPreview: async (sessionId): Promise<AnalysisRebuildPreview> => ({
      sessionId,
      status: analysisStatus("stale_rebuild_available"),
      selectedSource: "raceiq-raw",
      outputsReplaced: ["laps", "race_events", "session_runs", "race_result", "quality"],
      sourceAvailable: true,
      capability: {
        mode: "exact",
        sourceKind: "raceiq-raw",
        rebuildableArtifacts: ["laps", "race_events", "session_runs", "race_result", "quality"],
        unavailableArtifacts: [],
        limitations: [],
      },
      limitations: [],
    }),
    getLapsForSession: async () => [],
    reprocessSession: async (sessionId) => ({
      sessionId,
      lapsDetected: 1,
      lapsUpdated: 1,
      strategy: "in-place",
      analysisGenerationId: "analysis-generation:test",
    }),
    rebuildSessionEligibility: async (sessionId) => status(sessionId, "current"),
    getStaleSessions: async () => [],
    countStaleSessions: async () => 0,
    broadcastNotification: () => {},
    setStaleSessionsNotification: () => {},
    ...overrides,
  });
}

describe("session quality route semantics", () => {
  test("returns receipt-driven rebuild preview without writes", async () => {
    const response = await routes().request("/api/sessions/42/quality/rebuild-preview?gameId=iracing");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sessionId: 42,
      selectedSource: "raceiq-raw",
      sourceAvailable: true,
      outputsReplaced: ["laps", "race_events", "session_runs", "race_result", "quality"],
    });
  });
  test("returns expanded analysis status and cleanup eligibility", async () => {
    const response = await routes().request("/api/sessions/42/quality?gameId=iracing");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sessionId: 42,
      analysisStatus: { status: "current" },
      canonicalCleanupEligible: false,
    });
  });
  test("maps concurrent quality rebuild to 409", async () => {
    const response = await routes({
      getQualityRebuildStatus: async (sessionId) => status(sessionId, "reprocess"),
      reprocessSession: async () => {
        throw new AnalysisGenerationConflictError("analysis-set:test");
      },
    }).request("/api/sessions/42/quality/rebuild?gameId=iracing", { method: "POST" });
    expect(response.status).toBe(409);
  });

  test("reprocesses legacy current quality when receipt status is stale", async () => {
    const reprocessSession = mock(async (sessionId: number) => ({
      sessionId,
      lapsDetected: 1,
      lapsUpdated: 1,
      strategy: "in-place" as const,
      analysisGenerationId: "analysis-generation:test",
    }));
    const response = await routes({
      getQualityRebuildStatus: async (sessionId) => ({
        ...status(sessionId, "reprocess"),
        analysisStatus: analysisStatus("stale_rebuild_available"),
      }),
      reprocessSession,
    }).request("/api/sessions/42/quality/rebuild?gameId=iracing", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ strategy: "reprocess" });
    expect(reprocessSession).toHaveBeenCalledWith(42);
  });

  test("maps eligibility rebuild conflict to 409", async () => {
    const response = await routes({
      getQualityRebuildStatus: async (sessionId) => status(sessionId, "rebuild_eligibility"),
      rebuildSessionEligibility: async () => {
        throw new AnalysisGenerationConflictError("analysis-set:test");
      },
    }).request("/api/sessions/42/quality/rebuild?gameId=iracing", { method: "POST" });

    expect(response.status).toBe(409);
  });

  test("reports current strategy instead of a false no-op", async () => {
    const rebuildSessionEligibility = mock(async (sessionId: number) => status(sessionId, "current"));
    const response = await routes({ rebuildSessionEligibility })
      .request("/api/sessions/42/quality/rebuild?gameId=iracing", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ strategy: "current" });
    expect(rebuildSessionEligibility).not.toHaveBeenCalled();
  });

  test("returns 404 only when session existence check reports missing", async () => {
    const getQualityRebuildStatus = mock(async (sessionId: number) => status(sessionId, "current"));
    const response = await routes({
      sessionExistsForGame: async () => false,
      getQualityRebuildStatus,
    }).request("/api/sessions/42/quality?gameId=iracing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
    expect(getQualityRebuildStatus).not.toHaveBeenCalled();
  });

  test("keeps operational quality lookup failures as server failures", async () => {
    const response = await routes({
      getQualityRebuildStatus: async () => {
        throw new Error("database unavailable");
      },
    }).request("/api/sessions/42/quality?gameId=iracing");

    expect(response.status).toBe(500);
  });

  test("reports unavailable stale rebuilds and preserves stale health", async () => {
    const setStaleSessionsNotification = mock((_payload: Record<string, unknown> | null) => {});
    const response = await routes({
      getStaleSessions: async () => [42],
      getQualityRebuildStatus: async (sessionId) => status(sessionId, "unavailable"),
      countStaleSessions: async () => 1,
      setStaleSessionsNotification,
    }).request("/api/sessions/reprocess-stale", { method: "POST" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      reprocessed: 0,
      failed: 0,
      remaining: 1,
      results: [{ sessionId: 42, strategy: "unavailable" }],
    });
    expect(setStaleSessionsNotification).toHaveBeenCalledWith({
      type: "stale-lap-detection",
      sessionCount: 1,
      currentVersion: expect.any(String),
    });
  });

  test("reports partial bulk failures without clearing stale health", async () => {
    const setStaleSessionsNotification = mock((_payload: Record<string, unknown> | null) => {});
    const response = await routes({
      getStaleSessions: async () => [41, 42],
      getQualityRebuildStatus: async (sessionId) => status(sessionId, "reprocess"),
      reprocessSession: async (sessionId) => {
        if (sessionId === 42) throw new Error("database unavailable");
        return { sessionId, lapsDetected: 1, lapsUpdated: 1, strategy: "in-place", analysisGenerationId: "analysis-generation:test" };
      },
      countStaleSessions: async () => 1,
      setStaleSessionsNotification,
    }).request("/api/sessions/reprocess-stale", { method: "POST" });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      reprocessed: 1,
      failed: 1,
      remaining: 1,
      results: [
        { sessionId: 41, strategy: "reprocess" },
        { sessionId: 42, strategy: "failed", error: "Processing failed" },
      ],
    });
    expect(setStaleSessionsNotification).toHaveBeenCalledTimes(1);
    expect(setStaleSessionsNotification).not.toHaveBeenCalledWith(null);
  });

  test("reports bulk eligibility conflicts as 409", async () => {
    const response = await routes({
      getStaleSessions: async () => [42],
      getQualityRebuildStatus: async (sessionId) => status(sessionId, "rebuild_eligibility"),
      rebuildSessionEligibility: async () => {
        throw new AnalysisGenerationConflictError("analysis-set:test");
      },
      countStaleSessions: async () => 1,
    }).request("/api/sessions/reprocess-stale", { method: "POST" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      failed: 0,
      results: [{ sessionId: 42, strategy: "conflict", error: "Analysis rebuild already in progress" }],
    });
  });

  test("routes a no-raw policy-only stale session through eligibility rebuild", async () => {
    const rebuildSessionEligibility = mock(async (sessionId: number) => status(sessionId, "current"));
    const reprocessSession = mock(async (sessionId: number) => ({ sessionId, lapsDetected: 1, lapsUpdated: 1, strategy: "in-place" as const, analysisGenerationId: "analysis-generation:test" }));
    const response = await routes({
      getStaleSessions: async () => [42],
      getQualityRebuildStatus: async (sessionId) => status(sessionId, "rebuild_eligibility"),
      rebuildSessionEligibility,
      reprocessSession,
      countStaleSessions: async () => 0,
    }).request("/api/sessions/reprocess-stale", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reprocessed: 0,
      failed: 0,
      remaining: 0,
      results: [{ sessionId: 42, strategy: "eligibility" }],
    });
    expect(rebuildSessionEligibility).toHaveBeenCalledWith(42);
    expect(reprocessSession).not.toHaveBeenCalled();
  });

  test("clears stale health only after every bulk rebuild succeeds", async () => {
    const setStaleSessionsNotification = mock((_payload: Record<string, unknown> | null) => {});
    const response = await routes({
      getStaleSessions: async () => [41, 42],
      getQualityRebuildStatus: async (sessionId) => status(sessionId, sessionId === 41 ? "reprocess" : "rebuild_eligibility"),
      countStaleSessions: async () => 0,
      setStaleSessionsNotification,
    }).request("/api/sessions/reprocess-stale", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reprocessed: 1,
      failed: 0,
      remaining: 0,
      results: [
        { sessionId: 41, strategy: "reprocess" },
        { sessionId: 42, strategy: "eligibility" },
      ],
    });
    expect(setStaleSessionsNotification).toHaveBeenCalledWith(null);
  });
});
