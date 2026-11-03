import { describe, expect, test } from "bun:test";
import { fixturePath } from "../../support/fixtures";
import { processTelemetryBatch } from "@raceiq/telemetry-processor/batch";
import { readFileSync } from "node:fs";
import { fixtureFrames as readFixtureFrames } from "@raceiq/backend/test-support/fixture-frames";

describe("LMU telemetry batch metadata", () => {
  test("resolves recorded Bahrain layout and player car for one batch session", async () => {
    const path = fixturePath("sessions/lmu-real-opponents-2026-10-22.bin.gz");
    const frames = readFixtureFrames(readFileSync(path), "lmu").map(({ bytes }, index) => ({ data: bytes, rawByteOffset: index }));
    const result = await processTelemetryBatch("lmu", frames);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      gameId: "lmu",
      carId: "McLaren 720S LMGT3 Evo", trackId: "bahrainwec_2023/bahrainwec_outer",
    });
  });
});
