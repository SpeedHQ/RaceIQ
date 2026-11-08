import { expect, test } from "bun:test";
import { createIRacingParserState, normalizeIRacingFrame, projectIRacingLapIndex } from "../src/normalizer";
import { sampleFrame } from "./support/games/iracing-sdk";

for (const [mode, parse] of [["full", normalizeIRacingFrame], ["index", projectIRacingLapIndex]] as const) {
  test(`${mode} iRacing detection follows physical lap change before delayed SDK timer rollover`, () => {
    const state = createIRacingParserState();
    const input = sampleFrame();
    const samples = [
      { time: 125.5, lap: 3, sdk: 25.5, elapsed: 25.5, distance: 1200, pit: false, onTrack: true },
      { time: 200, lap: 4, sdk: 99, elapsed: 0, distance: 0, pit: true, onTrack: true },
      { time: 201, lap: 4, sdk: 100, elapsed: 1, distance: 20, pit: true, onTrack: false },
      { time: 203, lap: 4, sdk: 3, elapsed: 3, distance: 100, pit: false, onTrack: true },
    ];
    for (const sample of samples) {
      const packet = parse({ ...input, values: { ...input.values, SessionTime: sample.time, Lap: sample.lap,
        LapCurrentLapTime: sample.sdk, LapDist: sample.distance, OnPitRoad: sample.pit, IsOnTrack: sample.onTrack } }, state);
      expect(packet).toMatchObject({
        CurrentLap: sample.elapsed, LapNumber: sample.lap, TimestampMS: sample.time * 1000,
        DistanceTraveled: sample.lap * 6515 + sample.distance, IsRaceOn: sample.onTrack ? 1 : 0,
        RacePosition: 4,
        iracing: { sdkCurrentLapTime: sample.sdk, onPitRoad: sample.pit, incidents: 1, trackLengthM: 6515 },
      });
    }
  });
}
