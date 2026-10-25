import { describe, expect, test } from "bun:test";
import { resolveBalance } from "@raceiq/analysis-core/racing/analysis/metric-values";
import { lmuAdapter } from "@raceiq/game-lmu-metadata/index";
import { resolveAnalysisTelemetry } from "@raceiq/shared/racing/analysis/telemetry-capabilities";

const frame = (values: Record<string, unknown>) => ({ values, states: {} });

describe("LMU analysis metric values", () => {
  test("uses measured slip angles instead of yaw alone for balance", () => {
    const metric = resolveAnalysisTelemetry(lmuAdapter).balance;
    const balance = resolveBalance(frame({
      "motion.speed": 26.306163360979284,
      "motion.acceleration-x": 12.933746337890625,
      "motion.angular-velocity-y": -0.6624804139137268,
      "tires.tire-slip-angle": [-0.10003551308178779, -0.09726704146651437, -0.10494855205185476, -0.10478092787441247],
    }), metric);
    expect(balance?.slipAvailable).toBe(true);
    expect(balance?.state).toBe("neutral");
  });
});
