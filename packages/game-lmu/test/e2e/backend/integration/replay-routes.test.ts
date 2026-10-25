import { describe, expect, test } from "bun:test";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { deleteSession, insertSession } from "@raceiq/backend-core/db/session-queries";
import { cacheDelete, cacheSet } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { insertLap } from "@raceiq/backend-core/db/lap-mutation-queries";
import { packet } from "@raceiq/telemetry-core/test-support/telemetry/resolver";
import type { LMUExtendedData } from "@raceiq/shared/telemetry/lmu";
import type { SemanticLapTelemetry } from "@raceiq/lap-replay/contracts";
import { replayRoutes } from "@raceiq/lap-replay/server";

initGameAdapters();

describe("LMU semantic replay", () => {
  test.each([true, false])("uses canonical TC-active=%s for replay insights", async (active) => {
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
      if (!body.insights || !body.detectorCoverage) throw new Error("Replay omitted insights or detector coverage");
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
