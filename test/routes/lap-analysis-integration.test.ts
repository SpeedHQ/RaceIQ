import { describe, expect, test } from "bun:test";

import { insertLap } from "../../server/db/lap-mutation-queries";
import { deleteSession, insertSession, updateSessionRawFile } from "../../server/db/session-queries";
import { initServerGameAdapters } from "../../server/games/init";
import { lapRoutes } from "../../server/routes/laps";
import { iterateSessionCaptureFrames } from "../../server/session-capture/source-loader";
import { getRecordingFixture } from "../support/recordings/fixtures";


initServerGameAdapters();
describe("F1 Analyse semantic telemetry integration", () => {
  test("replays a real capture through the Analyse endpoint", async () => {
    const recording = getRecordingFixture("f1-2025-2026-04-09T21-34-10-190Z.bin.gz");
    if (!recording) throw new Error("Required F1 recording fixture is missing");

    let firstFrameOffset: number | undefined;
    for await (const record of iterateSessionCaptureFrames({
      rawFile: recording,
      source: null,
      gameId: "f1-2025",
      carOrdinal: 41,
      trackOrdinal: 19,
    })) {
      firstFrameOffset = record.offset;
      break;
    }
    if (firstFrameOffset == null) throw new Error("Recording contains no frames");

    const sessionId = await insertSession(41, 19, "f1-2025");
    const lapId = await insertLap(sessionId, 1, 1, true, firstFrameOffset, 1_000);
    await updateSessionRawFile(sessionId, recording, "test-detector");

    try {
      const response = await lapRoutes.request(`/api/laps/${lapId}/semantic-telemetry`, {
        headers: { "X-Game-Id": "f1-2025" },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        lapId: number;
        requestedSemanticIds: string[];
        envelopes: { sequence: number; values: { semanticId: string }[] }[];
        parseError: string | null;
      };
      expect(body.lapId).toBe(lapId);
      expect(body.parseError).toBeNull();
      expect(body.requestedSemanticIds).toHaveLength(40);
      expect(body.envelopes.length).toBeGreaterThan(0);
      expect(body.envelopes.map((envelope) => envelope.sequence)).toEqual(
        body.envelopes.map((_, index) => index),
      );
      expect(body.envelopes.every((envelope) => envelope.values.length > 0)).toBe(true);
    } finally {
      await deleteSession(sessionId);
    }
  }, 120000);
});
