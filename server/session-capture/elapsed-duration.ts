import { stat } from "node:fs/promises";
import type { GameId } from "@raceiq/shared/games/ids";
import { tryGetServerGame } from "../games/registry";
import { loadSessionSource, iterateSessionCaptureRecordsFromSource, type SessionCaptureSource } from "./source-loader";

type CachedDuration = { size: number; mtimeMs: number; elapsedSeconds: number | null };
const durationCache = new Map<string, CachedDuration>();
const MAX_CACHE_ENTRIES = 128;
const USES_SESSION_CLOCK: Partial<Record<GameId, true>> = {
  "fm-2023": true,
  "f1-2025": true,
  iracing: true,
  lmu: true,
};

/** Recover elapsed span from recorded UTC stamps or a game's reliable session clock. */
export async function getRecordedElapsedSeconds(source: SessionCaptureSource): Promise<number | null> {
  try {
    const info = await stat(source.rawFile);
    const cached = durationCache.get(source.rawFile);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.elapsedSeconds;
    let inContext = false;
    let domain: "utc" | "simulator" | null = null;
    let segmentMin = Infinity;
    let segmentMax = -Infinity;
    let segmentLast = -Infinity;
    let totalSeconds = 0;
    let known = true;
    let hasTiming = false;
    const finishSegment = () => {
      if (segmentMin !== Infinity) totalSeconds += (segmentMax - segmentMin) / (domain === "utc" ? 1000 : 1);
      segmentMin = Infinity;
      segmentMax = -Infinity;
      segmentLast = -Infinity;
      domain = null;
    };
    const addTime = (value: number, nextDomain: "utc" | "simulator") => {
      if (!Number.isFinite(value) || (domain !== null && domain !== nextDomain) || value < segmentLast) {
        known = false;
        return;
      }
      hasTiming = true;
      domain = nextDomain;
      segmentLast = value;
      segmentMin = Math.min(segmentMin, value);
      segmentMax = Math.max(segmentMax, value);
    };
    try {
      if (source.rawFile.endsWith(".motec.zip")) {
        // ACC MoTeC converter derives CurrentRaceTime from sample index × sample interval.
        if (source.gameId !== "acc") known = false;
        else {
          const loaded = await loadSessionSource(source);
          if (loaded.kind !== "packets" || loaded.packets.length === 0) known = false;
          else {
            for (const packet of loaded.packets) {
              if (!Number.isFinite(packet.CurrentRaceTime) || packet.CurrentRaceTime < 0) { known = false; break; }
              addTime(packet.CurrentRaceTime, "simulator");
            }
            finishSegment();
          }
        }
      } else {
        const game = tryGetServerGame(source.gameId);
        const useSimulatorClock = USES_SESSION_CLOCK[source.gameId] === true;
        let parserState = useSimulatorClock ? game?.createParserState?.() ?? null : null;
        for await (const record of iterateSessionCaptureRecordsFromSource(source)) {
          if (record.kind === "segment-boundary") {
            finishSegment();
            parserState = useSimulatorClock ? game?.createParserState?.() ?? null : null;
            continue;
          }
          if (record.kind === "segment-context") { inContext = true; continue; }
          if (record.kind === "segment-context-end") { inContext = false; continue; }
          if (record.kind !== "frame") continue;
          if (inContext) {
            if (useSimulatorClock && game) game.tryParse(record.frame, parserState);
            continue;
          }
          if (record.frameTimeMs !== undefined) {
            addTime(record.frameTimeMs, "utc");
          } else if (useSimulatorClock && game) {
            const packet = game.tryParse(record.frame, parserState);
            if (!packet) continue;
            if (source.gameId === "lmu" && Number.isFinite(packet.TimestampMS) && packet.TimestampMS >= 0) {
              // LMU source frames embed acquisition UTC, unlike the recorder prefix.
              addTime(packet.TimestampMS, "utc");
            } else if (Number.isFinite(packet.CurrentRaceTime) && packet.CurrentRaceTime >= 0) {
              addTime(packet.CurrentRaceTime, "simulator");
            } else known = false;
          } else if (!inContext) known = false;
          if (!known) break;
        }
        finishSegment();
      }
    } catch {
      known = false;
    }
    const elapsedSeconds = known && hasTiming ? totalSeconds : null;
    durationCache.set(source.rawFile, { size: info.size, mtimeMs: info.mtimeMs, elapsedSeconds });
    while (durationCache.size > MAX_CACHE_ENTRIES) durationCache.delete(durationCache.keys().next().value!);
    return elapsedSeconds;
  } catch {
    return null;
  }
}
