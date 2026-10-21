import { createHash, type Hash } from "node:crypto";
import type { GameId } from "@raceiq/shared/games/ids";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { getTrackLengthMetersById } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";
import { dashboardTrackIdentity } from "@raceiq/shared/racing/sessions/dashboard";
import { TrackConditionsAccumulator } from "../ai/track-conditions";
import { getServerGame } from "../games/registry";
import type { ObservedDashboardCaptureFacts } from "./dashboard-processor";
import { classifyLapAttribution, type DriverAttributionStint } from "@raceiq/shared/driver-attribution";
import type { DashboardDurationAttribution } from "../driver-summary/dashboard-input";
import { encodeLmuPacket } from "@raceiq/shared/telemetry/lmu-context";

const USES_SESSION_CLOCK: Partial<Record<GameId, true>> = { "fm-2023": true, "f1-2025": true, iracing: true, lmu: true };

type TimeDomain = "utc" | "simulator";

export interface DashboardSourceAttributionObservation {
  sessionId: string;
  clockDomain: string;
  sourceTimeMs: number;
  stints: readonly DriverAttributionStint[];
}

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
  private previousDuration: { value: number; domain: TimeDomain; sourceDomain: string | null; sourceSessionId: string | null; sourceTimeMs: number | null } | null = null;
  private readonly attributedDuration: DashboardDurationAttribution = {
    selfSeconds: 0, otherSeconds: 0, unknownSeconds: 0, selfObserved: false, coverage: "unavailable",
  };
  private attributionGap = false;
  private otherObserved = false;
  private layout: { starts: number[]; trackLengthM?: number } | null = null;
  private readonly gameId: GameId;
  private readonly trackId: string | null;

  constructor(gameId: GameId, trackId: string | null) {
    this.gameId = gameId;
    this.trackId = trackId;
  }

  observe(packet: TelemetryPacket, source: Buffer | { rawOffset: number } | undefined, frameTimeMs?: number,
    attribution?: DashboardSourceAttributionObservation): void {
    this.packetCount++;
    if (Buffer.isBuffer(source)) this.hash.update(source);
    else this.hash.update(JSON.stringify(encodeLmuPacket(packet)));

    const adapter = getServerGame(this.gameId);
    const time = frameTimeMs ?? packet.extendedRaceIQ?.frameTimeMs;
    if (time !== undefined && Number.isFinite(time)) this.addTime(time, "utc", attribution);
    else if (USES_SESSION_CLOCK[this.gameId]) {
      const useUtc = this.gameId === "lmu" && Number.isFinite(packet.TimestampMS) && packet.TimestampMS > 0;
      const value = useUtc ? packet.TimestampMS
        : this.gameId === "lmu" ? packet.lmu?.elapsedTime : packet.CurrentRaceTime;
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) this.addTime(value, useUtc ? "utc" : "simulator", attribution);
      else this.missingTime();
    } else this.missingTime();

    this.weather.add(packet);
    if (!this.layout && adapter.getNativeSectorLayout) {
      const found = adapter.getNativeSectorLayout(packet);
      if (found && found.starts.length >= 2 && found.starts.length <= 16
        && found.starts.every((start) => Number.isFinite(start) && start >= 0 && start < 1)) {
        this.layout = { starts: [...found.starts], trackLengthM: found.trackLengthM };
      }
    }
  }

  finishSegment(gap = true): void {
    if (this.segmentMin !== Infinity && this.segmentDomain !== null && this.timeSampleCount >= 2 && this.segmentMax > this.segmentMin) {
      this.elapsedSeconds += (this.segmentMax - this.segmentMin) / (this.segmentDomain === "utc" ? 1000 : 1);
      this.hasTiming = true;
    } else if (this.segmentMin !== Infinity) this.timingKnown = false;
    this.segmentMin = Infinity;
    this.segmentMax = -Infinity;
    this.segmentDomain = null;
    this.timeSampleCount = 0;
    this.previousDuration = null;
    if (gap && this.packetCount > 0) this.attributionGap = true;
  }

  toFacts(): ObservedDashboardCaptureFacts {
    this.finishSegment(false);
    if (this.packetCount === 0) this.timingKnown = false;
    const conditions = this.weather.result();
    const trackLengthMeters = this.layout?.trackLengthM ?? getTrackLengthMetersById(this.trackId ?? "", this.gameId);
    const trackKey = dashboardTrackIdentity(this.gameId, this.trackId);
    const starts = this.layout?.starts ?? null;
    const weatherRevision = conditions ? createHash("sha256").update(JSON.stringify(conditions)).digest("hex") : null;
    return {
      captureRevision: `${this.hash.copy().digest("hex")}:packet-pass:${this.packetCount}`,
      duration: {
        status: this.timingKnown && this.hasTiming ? "available" : "unavailable",
        elapsedSeconds: this.timingKnown && this.hasTiming ? this.elapsedSeconds : null,
        attribution: { ...this.attributedDuration,
          coverage: this.attributedDuration.selfObserved || this.otherObserved
            ? this.attributionGap ? "partial" : "complete" : "unavailable" },
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

  private addTime(value: number, domain: TimeDomain, attribution?: DashboardSourceAttributionObservation): void {
    if (this.segmentDomain !== null && this.segmentDomain !== domain) this.timingKnown = false;
    if (this.segmentDomain === null) this.segmentDomain = domain;
    if (value < this.segmentMin) this.segmentMin = value;
    if (value > this.segmentMax) this.segmentMax = value;
    this.timeSampleCount++;
    const sourceKnown = attribution && attribution.sessionId && attribution.clockDomain && Number.isFinite(attribution.sourceTimeMs);
    const prior = this.previousDuration;
    if (prior) {
      if (prior.domain !== domain || value < prior.value) {
        this.attributionGap = true;
        this.timingKnown = false;
      } else {
        const seconds = (value - prior.value) / (domain === "utc" ? 1000 : 1);
        const owner = sourceKnown && prior.sourceDomain === attribution.clockDomain && prior.sourceSessionId === attribution.sessionId
          && prior.sourceTimeMs !== null
          && attribution.stints.every((stint) => stint.startMs >= attribution.sourceTimeMs
            || stint.endMs !== null && stint.endMs <= prior.sourceTimeMs!
            || stint.gameId === this.gameId && stint.sessionId === attribution.sessionId)
          ? classifyLapAttribution(attribution.stints, prior.sourceTimeMs, attribution.sourceTimeMs, attribution.clockDomain)
          : "Unknown";
        if (owner === "Self") {
          this.attributedDuration.selfSeconds += seconds;
          this.attributedDuration.selfObserved = true;
        } else if (owner === "Other") {
          this.attributedDuration.otherSeconds += seconds;
          this.otherObserved = true;
        } else {
          // A mixed source interval lacks an observed duration-clock swap boundary.
          this.attributedDuration.unknownSeconds += seconds;
          this.attributionGap = true;
        }
      }
    }
    this.previousDuration = { value, domain, sourceDomain: sourceKnown ? attribution.clockDomain : null,
      sourceSessionId: sourceKnown ? attribution.sessionId : null, sourceTimeMs: sourceKnown ? attribution.sourceTimeMs : null };
  }

  private missingTime(): void {
    this.timingKnown = false;
    this.attributionGap = true;
    this.previousDuration = null;
  }
}
