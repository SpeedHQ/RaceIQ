import { describe, test, expect } from "bun:test";
import { initServerGameAdapters } from "../../server/games/init";
import { recordingPacketRoutes } from "../../server/routes/dev/recording-routes";
import type {
  LiveTelemetryFrameMessageV1,
  LiveTelemetrySchemaMessageV1,
} from "../../shared/telemetry/live/contracts";
import { viewToGearingSample } from "../../client/src/hooks/useGearingIngest";
import { buildLiveTelemetryView } from "../../client/src/lib/live-telemetry-view";
import { computeGearingState, computeTrackLaps } from "../../client/src/lib/session-gearing";
import type { GearingSample } from "../../client/src/lib/gearing-telemetry";

describe("dev recording routes", () => {
  initServerGameAdapters();

  test("GET /api/dev/e2e-telemetry/:recordingName resolves recorded packets through the live semantic pipeline", async () => {
    const res = await recordingPacketRoutes.request(
      "/api/dev/e2e-telemetry/fm-2023-2026-04-09T21-53-00-102Z"
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      packetCount: number;
      schema: LiveTelemetrySchemaMessageV1 | null;
      frames: LiveTelemetryFrameMessageV1[];
    };
    expect(body.packetCount).toBeGreaterThan(0);
    expect(body.schema).not.toBeNull();
    expect(body.frames).toHaveLength(body.packetCount);

    // Every frame must decode through the live decoder; frames missing
    // required semantics are rejected exactly like live ingestion.
    const schema = body.schema!;
    expect(body.frames.every((f) => f.schemaId === schema.schemaId)).toBe(true);

    const kmh = (ms: number) => ms * 3.6;
    const samples = body.frames
      .map((frame) => {
        const view = buildLiveTelemetryView(schema, frame);
        if (!view) throw new Error("frame failed to decode");
        return viewToGearingSample(view, kmh);
      })
      .filter((sample): sample is GearingSample => sample !== null);

    const state = computeGearingState(samples);
    expect(state.powerCurve.length).toBeGreaterThan(0);
    expect(state.torqueCurve.length).toBeGreaterThan(0);
    expect(Object.keys(state.powerCurves).length).toBeGreaterThan(0);

    const trackLaps = computeTrackLaps(samples);
    expect(trackLaps.current?.samples.length ?? 0).toBeGreaterThan(0);
  }, { timeout: 30000 });
});
