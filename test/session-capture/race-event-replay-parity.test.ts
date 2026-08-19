import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { initGameAdapters } from "../../shared/games/init";
import { LOCAL_PLAYER_EVIDENCE } from "../../shared/racing/quality/contracts";
import { initServerGameAdapters } from "../../server/games/init";
import { rebuildRaceEventTimeline, type RebuildRaceEventTimelineInput } from "../../server/race-events/rebuild";
import { readIRacingFrames } from "../../server/games/iracing/recorder";
import { currentTelemetryVersionIdentity } from "../../server/telemetry/pipeline-ports";

initGameAdapters();
initServerGameAdapters();

const FIXTURE = resolve(
  import.meta.dir,
  "../artifacts/sessions/iracing-daytona-am-vantage-gt3-pit.bin.gz",
);

describe("raw race-event replay parity", () => {
  test("rebuilds stable semantic IDs and canonical order from identical frames", async () => {
    const frames = readIRacingFrames(FIXTURE).map((frame, index) => ({
      frame,
      rawByteOffset: index,
    }));
    const input: RebuildRaceEventTimelineInput = {
      sessionId: 7_001,
      gameId: "iracing",
      frames,
      sourceKind: "raceiq-raw",
      participant: LOCAL_PLAYER_EVIDENCE,
      versionIdentity: currentTelemetryVersionIdentity("iracing"),
      sourceVerification: {
        state: "verified",
        sourceGeneration: "sha256:replay-parity-source",
      },
      canonicalVerification: {
        state: "verified",
        sourceGeneration: "sha256:replay-parity-canonical",
      },
    };

    const first = await rebuildRaceEventTimeline(input);
    const second = await rebuildRaceEventTimeline(input);

    expect(first.events.length).toBeGreaterThan(0);
    expect(second.events.map(({ eventId }) => eventId)).toEqual(
      first.events.map(({ eventId }) => eventId),
    );
    expect(second.events.map(({ contentHash }) => contentHash)).toEqual(
      first.events.map(({ contentHash }) => contentHash),
    );
    expect(second.laps.map(({ lapNumber }) => lapNumber)).toEqual(
      first.laps.map(({ lapNumber }) => lapNumber),
    );
    expect(first.runs.length).toBeGreaterThan(0);
    expect(second.runs).toEqual(first.runs);
    expect(second.memberships).toEqual(first.memberships);
    expect(second.evidence).toEqual(first.evidence);
  });
});
