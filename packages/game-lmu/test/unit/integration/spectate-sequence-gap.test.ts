import { expect, test } from "bun:test";
import type { ComparisonData } from "@raceiq/shared/racing/comparison/types";
import type { SemanticLapTelemetry } from "@raceiq/lap-replay/contracts";
import { createSpectateController, prepareSpectateLap } from "@raceiq/lap-replay/test-support/spectate-replay";

test("LMU source-sequence gaps stay unavailable through prepared pose and aligned trace sampling", () => {
  const replay: SemanticLapTelemetry = {
    lapId: 1,
    requestedSemanticIds: [],
    envelopes: [0, 0.05].map((time, index) => ({
      sequence: index === 0 ? 0 : 2,
      simulator: "lmu",
      observedAt: { domain: "session", milliseconds: time * 1000 },
      receivedAt: { domain: "session", milliseconds: time * 1000 },
      values: Object.entries({
        "timing.current-lap": time, "timing.distance-traveled": time * 1000,
        "motion.position-x": time * 1000, "motion.position-z": 0, "motion.yaw": 0, "motion.speed": 100,
      }).map(([semanticId, value]) => ({ semanticId, value, state: "ok", freshness: "fresh" })),
    })),
  };
  const comparison = { traces: {
    distance: [0, 50], elapsedTimeA: [0, 0.05], elapsedTimeB: [0, 0.05],
    positionXA: [0, 50], positionZA: [0, 0], positionXB: [0, 50], positionZB: [5, 5],
  } } as unknown as ComparisonData;
  const prepared = prepareSpectateLap(replay, comparison);
  const controller = createSpectateController(prepared, null);
  try {
    expect(controller.sample(0.025).a).toBeNull();
    expect(controller.sample(0).a?.pose?.x).toBe(0);
    expect(controller.sample(0.05).a?.pose?.x).toBe(50);
  } finally {
    controller.dispose();
  }
});
