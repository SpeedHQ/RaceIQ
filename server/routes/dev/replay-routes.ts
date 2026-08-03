import { Hono } from "hono";
import { getGame } from "../../../shared/games/registry";
import { readRecordedTelemetry } from "../../session-capture/replay-packets";
import { getServerGame } from "../../games/registry";
import { PitTracker } from "../../live-strategy/pit-tracker";
import { SectorTracker } from "../../live-strategy/sector-tracker";
import { wsManager } from "../../runtime/websocket-manager";
import {
  resolveRecordingGameId,
  resolveRecordingPath,
} from "./recording-support";

const DEFAULT_PACKET_LIMIT = 160;
const DEFAULT_INTERVAL_MS = 24;

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

export const replayRoutes = new Hono().post(
  "/api/dev/replay/:recordingName",
  async (c) => {
    const recordingName = c.req.param("recordingName");
    const recordingPath = resolveRecordingPath(recordingName);
    if (!recordingPath.ok) {
      return c.json({ error: recordingPath.error }, recordingPath.status);
    }

    const gameId = resolveRecordingGameId(recordingName);
    if (!gameId) {
      return c.json({ error: "Could not determine recording game" }, 400);
    }

    const packetLimit = boundedInteger(
      c.req.query("packets"),
      DEFAULT_PACKET_LIMIT,
      2,
      600,
    );
    const intervalMs = boundedInteger(
      c.req.query("intervalMs"),
      DEFAULT_INTERVAL_MS,
      0,
      100,
    );
    const recorded = readRecordedTelemetry(gameId, recordingPath.path);
    if (recorded.packets.length === 0) {
      return c.json({ error: "No telemetry packets found in recording" }, 400);
    }
    // Preserve both ends of recording when downsampling. Event-bearing frames
    // often occur near session end (pit entry/exit); modulo sampling can drop
    // them entirely and make browser replay claim fixture lacks transition.
    const sampleCount = Math.min(packetLimit, recorded.packets.length);
    const packets =
      sampleCount === recorded.packets.length
        ? recorded.packets
        : Array.from({ length: sampleCount }, (_, index) => {
            const sourceIndex =
              sampleCount === 1
                ? 0
                : Math.round(
                    (index * (recorded.packets.length - 1)) /
                      (sampleCount - 1),
                  );
            return recorded.packets[sourceIndex]!;
          });

    wsManager.broadcastStatus({
      udpPps: 0,
      isRaceOn: true,
      droppedPackets: 0,
      udpPort: 0,
      detectedGame: {
        id: gameId,
        name: getGame(gameId).displayName,
      },
      currentSession: null,
    });

    const sectorTracker = new SectorTracker();
    await sectorTracker.reset(
      packets[0]!.TrackOrdinal,
      gameId,
      packets[0]!.CarOrdinal,
    );
    const pitTracker = new PitTracker();
    pitTracker.reset();
    pitTracker.setTireThresholds(getServerGame(gameId).tireHealthThresholds.yellow);

    for (const packet of packets) {
      const sectors = sectorTracker.feed(packet);
      const pit = pitTracker.feed(
        packet,
        sectorTracker.getTrackLength(),
        sectorTracker.getLapDistStart(),
      );
      wsManager.broadcast(packet, sectors, pit);
      if (intervalMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    wsManager.broadcastNotification({
      type: "dev-replay-complete",
      gameId,
      recordingName,
      packetCount: packets.length,
    });

    return c.json({
      ok: true,
      gameId,
      recordingName,
      sourcePacketCount: recorded.packets.length,
      replayedPacketCount: packets.length,
      carModel: recorded.carModel,
      trackName: recorded.trackName,
    });
  },
).post("/api/dev/disconnect", (c) => {
  const disconnectedClients = wsManager.connectedClients;
  wsManager.disconnectClients();
  return c.json({ ok: true, disconnectedClients });
});
