import { createHash, type Hash } from "node:crypto";
import type { GameId } from "@raceiq/shared/games/ids";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { getTrackLengthMeters } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";
import { dashboardTrackIdentity } from "@raceiq/shared/racing/sessions/dashboard";
import { TrackConditionsAccumulator } from "../ai/track-conditions";
import { getServerGame } from "../games/registry";
import type { ObservedDashboardCaptureFacts } from "./dashboard-processor";

const USES_SESSION_CLOCK: Partial<Record<GameId, true>> = { "fm-2023": true, "f1-2025": true, iracing: true, lmu: true };

type TimeDomain = "utc" | "simulator";

/** Scalar-only observation; retains no packet, frame, or lap arrays. */
export class DashboardCaptureObservation {
  private readonly hash: Hash = createHash("sha256");
  private readonly weather = new TrackConditionsAccumulator();
  private packetCount = 0;
  private timingKnown = true;
  private hasTiming = false;
  private elapsedSeconds = 0;
  private segmentMin = Infinity;
  private segmentMax = -Infinity;
  private segmentDomain: TimeDomain | null = null;
  private timeSampleCount = 0;
  private layout: { starts: number[]; trackLengthM?: number } | null = null;
  private readonly gameId: GameId;
  private readonly trackOrdinal: number;
  private readonly trackId: string | number | null;

  constructor(gameId: GameId, trackOrdinal: number, trackId: string | number | null) {
    this.gameId = gameId;
    this.trackOrdinal = trackOrdinal;
    this.trackId = trackId;
  }

  observe(packet: TelemetryPacket, source: Buffer | { rawOffset: number } | undefined, frameTimeMs?: number): void {
    this.packetCount++;
    if (Buffer.isBuffer(source)) this.hash.update(source);
    else this.hash.update(JSON.stringify(packet));

    const adapter = getServerGame(this.gameId);
    const time = frameTimeMs ?? packet.extendedRaceIQ?.frameTimeMs;
    if (time !== undefined && Number.isFinite(time)) this.addTime(time, "utc");
    else if (USES_SESSION_CLOCK[this.gameId]) {
      const useUtc = this.gameId === "lmu" && Number.isFinite(packet.TimestampMS) && packet.TimestampMS >= 0;
      const value = useUtc ? packet.TimestampMS : packet.CurrentRaceTime;
      if (Number.isFinite(value) && value >= 0) this.addTime(value, useUtc ? "utc" : "simulator");
      else this.timingKnown = false;
    } else this.timingKnown = false;

    this.weather.add(packet);
    if (!this.layout && adapter.getNativeSectorLayout) {
      const found = adapter.getNativeSectorLayout(packet);
      if (found && found.starts.length >= 2 && found.starts.length <= 16
        && found.starts.every((start) => Number.isFinite(start) && start >= 0 && start < 1)) {
        this.layout = { starts: [...found.starts], trackLengthM: found.trackLengthM };
      }
    }
  }

  finishSegment(): void {
    if (this.segmentMin !== Infinity && this.segmentDomain !== null && this.timeSampleCount >= 2 && this.segmentMax > this.segmentMin) {
      this.elapsedSeconds += (this.segmentMax - this.segmentMin) / (this.segmentDomain === "utc" ? 1000 : 1);
      this.hasTiming = true;
    } else if (this.segmentMin !== Infinity) this.timingKnown = false;
    this.segmentMin = Infinity;
    this.segmentMax = -Infinity;
    this.segmentDomain = null;
    this.timeSampleCount = 0;
  }

  toFacts(): ObservedDashboardCaptureFacts {
    this.finishSegment();
    if (this.packetCount === 0) this.timingKnown = false;
    const conditions = this.weather.result();
    const trackLengthMeters = this.layout?.trackLengthM ?? getTrackLengthMeters(this.trackOrdinal, this.gameId);
    const trackKey = dashboardTrackIdentity(this.gameId, this.trackId, this.trackOrdinal);
    const starts = this.layout?.starts ?? null;
    const weatherRevision = conditions ? createHash("sha256").update(JSON.stringify(conditions)).digest("hex") : null;
    return {
      captureRevision: `${this.hash.copy().digest("hex")}:packet-pass:${this.packetCount}`,
      duration: {
        status: this.timingKnown && this.hasTiming ? "available" : "unavailable",
        elapsedSeconds: this.timingKnown && this.hasTiming ? this.elapsedSeconds : null,
      },
      sectorLayout: starts ? {
        status: "available",
        key: `${trackKey}:${starts.join(",")}`,
        sectorCount: starts.length,
        starts,
      } : null,
      weather: { status: conditions ? "available" : "unavailable", revision: weatherRevision, conditions },
      trackLengthMeters: Number.isFinite(trackLengthMeters) && trackLengthMeters! > 0 ? trackLengthMeters! : null,
      sourceSectorStarts: starts,
    };
  }

  private addTime(value: number, domain: TimeDomain): void {
    if (this.segmentDomain !== null && this.segmentDomain !== domain) this.timingKnown = false;
    if (this.segmentDomain === null) this.segmentDomain = domain;
    if (value < this.segmentMin) this.segmentMin = value;
    if (value > this.segmentMax) this.segmentMax = value;
    this.timeSampleCount++;
  }
}
