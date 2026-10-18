import { describe, expect, test } from "bun:test";
import { readAMS2DumpFrames } from "@raceiq/capture-formats/ams2/dump";
import { processTelemetryBatch } from "../src/batch";
import { getGameParser } from "../src/routing";

describe("portable AMS2 parser routing", () => {
  test("reuses AMS2 parsing and Time Trial lap rules for real capture bytes", async () => {
    const parser = getGameParser("ams2");
    const frames = [];
    for await (const data of readAMS2DumpFrames(`${import.meta.dir}/../../../test/artifacts/sessions/ams2-time-trial.bin.gz`)) {
      expect(parser.canHandle(data)).toBe(true);
      frames.push({ data });
    }
    const result = await processTelemetryBatch("ams2", frames);
    const complete = result.laps.filter(lap => lap.complete);
    expect(result.sessions).toHaveLength(1);
    expect(complete.map(lap => lap.lapTime.toFixed(3))).toEqual(["50.460", "52.080", "51.300"]);
    expect(complete.map(lap => lap.invalidReason)).toEqual(["outlap", null, null]);
  });

  test("preserves race-start eligibility and actual pit exclusions", async () => {
    const frames = [];
    for await (const data of readAMS2DumpFrames(`${import.meta.dir}/../../../test/artifacts/sessions/ams2-race-pit-stop.bin.gz`)) frames.push({ data });
    const result = await processTelemetryBatch("ams2", frames);
    const complete = result.laps.filter(lap => lap.complete);
    expect(result.sessions).toHaveLength(1);
    expect(complete.map(lap => lap.lapTime.toFixed(3))).toEqual(["84.850", "72.645", "112.819", "70.170", "66.820"]);
    expect(complete.map(lap => lap.invalidReason)).toEqual([null, null, "inlap", "outlap", null]);
  });
});
