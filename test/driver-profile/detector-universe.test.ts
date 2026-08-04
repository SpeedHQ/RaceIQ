import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ALL_DETECTOR_IDS } from "../../server/driver-profile/detectors";

describe("detector universe stays in lockstep with lap-analysis insights", () => {
  test("ALL_DETECTOR_IDS covers every id analyzeLap can emit", () => {
    const insightDir = join(import.meta.dir, "..", "..", "shared", "racing", "analysis", "laps", "insights");
    const src = [
      "suspension.ts",
      "tires.ts",
      "driving-core.ts",
      "driving-advanced.ts",
      "mechanical.ts",
    ]
      .map((file) => readFileSync(join(insightDir, file), "utf8"))
      .join("\n");
    const wheels = ["FL", "FR", "RL", "RR"];

    const found = new Set<string>();
    for (const m of src.matchAll(/\bid: "([^"]+)"/g)) found.add(m[1]);
    // Template ids are always `<prefix>${wheelExpr}` — expand over the wheels.
    for (const m of src.matchAll(/\bid: `([^`$]+)\$\{[^`]*\}`/g)) {
      for (const w of wheels) found.add(`${m[1]}${w}`);
    }

    expect(found.size).toBeGreaterThan(20);
    const missing = [...found].filter((id) => !ALL_DETECTOR_IDS.includes(id)).sort();
    const stale = ALL_DETECTOR_IDS.filter((id) => !found.has(id)).sort();
    expect(missing).toEqual([]);
    expect(stale).toEqual([]);
  });
});
