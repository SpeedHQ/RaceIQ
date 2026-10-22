import { describe, expect, test } from "bun:test";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { getGame } from "@raceiq/shared/games/registry";
import { analyseSemanticIds } from "@raceiq/shared/games/metric-contracts";
import { deleteSession, insertSession } from "@raceiq/backend-core/db/session-queries";
import { cacheDelete, cacheSet } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { insertLap } from "@raceiq/backend-core/db/lap-mutation-queries";
import { packet } from "@raceiq/telemetry-core/test-support/telemetry/resolver";
import { replayRoutes, semanticReplayIds } from "../../server";
import type { LMUExtendedData } from "@raceiq/shared/telemetry/lmu";
import type { SemanticLapTelemetry } from "../../contracts/replay";

initGameAdapters();
test("semantic replay requests F1 Analyse dependencies", () => {
  const ids = semanticReplayIds("f1-2025");
  expect(ids).toEqual(analyseSemanticIds(getGame("f1-2025")));
  expect(ids).toContain("timing.current-lap");
  expect(ids).toContain("timing.lap-fraction");
  expect(ids).toContain("tire.temperature.surface.representative");
  expect(ids).toContain("tire.temperature.surface.inner");
  expect(ids).toContain("tire.temperature.surface.middle");
  expect(ids).toContain("tire.temperature.surface.outer");
  expect(ids).toContain("tire.temperature.core");
  expect(ids).not.toContain("tires.wheel-in-puddle-depth");
});

describe("GET /api/laps/:id/semantic-telemetry", () => {
  test("returns full F1 Analyse replay with adapter channels", async () => {
    const sessionId = await insertSession("0", "0", "f1-2025");
    const lapId = await insertLap(sessionId, 1, 80.9, true, null, 0, null, null, null, null, null);
    cacheSet(lapId, [
      packet("f1-2025", { TimestampMS: 1_000, Speed: 10 }),
      packet("f1-2025", { TimestampMS: 1_017, Speed: 20 }),
    ]);
    try {
      const response = await replayRoutes.request(`/api/laps/${lapId}/semantic-telemetry`, {
        headers: { "X-Game-Id": "f1-2025" },
      });

      expect(response.status).toBe(200);
      const body = await response.json() as {
        lapId: number;
        requestedSemanticIds: readonly string[];
        envelopes: { sequence: number; values: { semanticId: string }[] }[];
        parseError: string | null;
      };
      expect(body.lapId).toBe(lapId);
      expect(body.parseError).toBeNull();
      expect(body.requestedSemanticIds).toEqual(analyseSemanticIds(getGame("f1-2025")));
      expect(body.envelopes).toHaveLength(2);
      expect(body.envelopes.map((envelope) => envelope.sequence)).toEqual([0, 1]);
      expect(body.envelopes[0]?.values).toEqual(
        expect.arrayContaining([expect.objectContaining({ semanticId: "motion.speed", value: 10 })]),
      );
      expect(body.envelopes[1]?.values).toEqual(
        expect.arrayContaining([expect.objectContaining({ semanticId: "motion.speed", value: 20 })]),
      );
    } finally {
      cacheDelete(lapId);
      await deleteSession(sessionId);
    }
  });
  test.each([true, false])("uses canonical TC-active=%s for LMU replay insights", async (active) => {
    const sessionId = await insertSession("0", "0", "lmu");
    const lapId = await insertLap(sessionId, 1, 80.9, true, null, 0, null, null, null, null, null);
    cacheSet(lapId, Array.from({ length: 32 }, (_, index) => packet("lmu", {
      TimestampMS: index * 20,
      CurrentRaceTime: index * 0.02,
      lmu: { tcActive: active && index < 4 } as LMUExtendedData,
    })));
    try {
      const response = await replayRoutes.request(`/api/laps/${lapId}/semantic-telemetry`, { headers: { "X-Game-Id": "lmu" } });
      expect(response.status).toBe(200);
      const body = await response.json() as SemanticLapTelemetry;
      expect(body.envelopes[0]?.values).toContainEqual(expect.objectContaining({ semanticId: "electronics.tc-active", value: active }));
      const tc = body.insights.find((insight) => insight.id === "driving-traction-control-activation");
      if (active) {
        expect(tc?.evidenceSource).toBe("native");
        expect(tc?.detail).toContain("0.08s active");
      } else {
        expect(tc).toBeUndefined();
        expect(body.detectorCoverage.find((detector) => detector.id === "driving-traction-control-activation")?.status).toBe("checked");
      }
    } finally {
      cacheDelete(lapId);
      await deleteSession(sessionId);
    }
  });
});
