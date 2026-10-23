import { describe, expect, test } from "bun:test";
import { fixturePath } from "../../support/fixtures";
import { processTelemetryBatch } from "@raceiq/telemetry-processor/batch";
import { readLMUFrames } from "@raceiq/capture-formats/lmu/dump";

describe("LMU telemetry batch metadata", () => {
  test("retains parser-provided identity in session metadata", async () => {
    const path = fixturePath("sessions/lmu-spa-iron-lynx-gte.bin.gz");
    const frames = readLMUFrames(path).map((data, index) => ({ data, rawByteOffset: index }));
    expect(frames.length).toBeGreaterThan(0);
    const result = await processTelemetryBatch("lmu", frames);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      gameId: "lmu", sessionUID: expect.stringContaining("porsche_911rsr-19_2023"),
      carId: "porsche_911rsr-19_2023", trackId: "Circuit de Spa-Francorchamps",
    });
  });
});
