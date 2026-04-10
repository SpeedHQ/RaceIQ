import type { GameId } from "../../shared/types";
import type { LapSavedNotification } from "../../server/lap-detector";
import { CapturingDbAdapter, CapturingWsAdapter } from "../../server/pipeline-adapters";
import { LapDetectorV2 } from "../../server/lap-detector-v2";
import { ensureInit, readAccPackets, readUdpPackets } from "./parse-dump";
import type { DumpResult } from "./parse-dump";

/**
 * Feed a recorded dump through LapDetectorV2 (bypassing Pipeline/v1) and return
 * the same shape as parseDump so v2 e2e tests can compare results.
 */
export async function parseDumpV2(
  gameId: GameId,
  dumpPath: string
): Promise<DumpResult> {
  ensureInit();

  const db = new CapturingDbAdapter();
  const ws = new CapturingWsAdapter();
  const notifications: (LapSavedNotification | Record<string, unknown>)[] = [];

  const detector = new LapDetectorV2({
    db,
    onLapSaved: (n) => {
      notifications.push(n);
      ws.broadcastNotification(n as unknown as Record<string, unknown>);
    },
  });

  const parsed = gameId === "acc" ? readAccPackets(dumpPath) : readUdpPackets(dumpPath);

  for (const packet of parsed.packets) {
    ws.broadcast(packet);
    await detector.feed(packet);
  }

  // Flush deferred insertLap calls
  await new Promise<void>((r) => setTimeout(r, 0));

  const rawPackets = ws.broadcastedPackets.map((e) => e.packet);

  return {
    laps: db.laps,
    sessions: db.sessions,
    carModel: parsed.carModel,
    trackName: parsed.trackName,
    wsNotifications: notifications,
    wsDevStates: ws.broadcastedDevStates,
    rawPackets,
  };
}
