import { describe, expect, test } from "bun:test";
import type { TelemetryVariableId } from "../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import { semanticValues } from "../src/components/track-map/types";

describe("semantic key contract", () => {
  test("accepts catalog IDs and rejects unknown runtime IDs", () => {
    const values = semanticValues([
      { semanticId: "motion.roll", value: 0.2 },
      { semanticId: "motion.rool", value: 99 },
    ]);

    expect(values["motion.roll"]).toBe(0.2);
    expect(Object.hasOwn(values, "motion.rool")).toBe(false);
  });

  test("catalog union accepts valid semantic keys", () => {
    const key: TelemetryVariableId = "motion.roll";
    expect(key).toBe("motion.roll");
  });

  // @ts-expect-error Unknown semantic IDs must not compile.
  const invalidKey: TelemetryVariableId = "motion.rool";
  void invalidKey;
});
