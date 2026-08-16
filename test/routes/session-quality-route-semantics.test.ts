import { describe, expect, mock, test } from "bun:test";
import type { QualityRebuildAction, QualityRebuildStatus } from "../../server/lap-analysis/quality-rebuild";
import { createSessionRoutes, type SessionRouteDependencies } from "../../server/routes/session-routes";

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
    },
  };
}

function routes(overrides: Partial<SessionRouteDependencies> = {}) {
  return createSessionRoutes({
    sessionExists: async () => true,
    getQualityRebuildStatus: async (sessionId) => status(sessionId, "current"),
    getLapsForSession: async () => [],
    reprocessSession: async (sessionId) => ({
      sessionId,
      lapsDetected: 1,
      lapsUpdated: 1,
      strategy: "in-place",
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
  test("returns 404 only when session existence check reports missing", async () => {
    const getQualityRebuildStatus = mock(async (sessionId: number) => status(sessionId, "current"));
    const response = await routes({
      sessionExists: async () => false,
      getQualityRebuildStatus,
    }).request("/api/sessions/42/quality");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
    expect(getQualityRebuildStatus).not.toHaveBeenCalled();
  });

  test("keeps operational quality lookup failures as server failures", async () => {
    const response = await routes({
      getQualityRebuildStatus: async () => {
        throw new Error("database unavailable");
      },
    }).request("/api/sessions/42/quality");

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
        return { sessionId, lapsDetected: 1, lapsUpdated: 1, strategy: "in-place" };
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

  test("routes a no-raw policy-only stale session through eligibility rebuild", async () => {
    const rebuildSessionEligibility = mock(async (sessionId: number) => status(sessionId, "current"));
    const reprocessSession = mock(async (sessionId: number) => ({ sessionId, lapsDetected: 1, lapsUpdated: 1, strategy: "in-place" as const }));
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
