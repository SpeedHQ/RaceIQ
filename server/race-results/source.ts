import type { RaceResultClaimEvidence, RaceResultEvidence, RaceResultSourceStatus } from "../../shared/racing/results/types";
import type { GameId } from "../../shared/games/ids";
import type { RaceEvent } from "../../shared/racing/events/contracts";
import type { RaceEventObservation } from "../games/types";
import type { RaceResultClaimSource, RaceResultSourceEvidence, RaceSourceObservation, ResultClassification } from "./types";
import { createRaceResultProvenance } from "./provenance";
import { resolveRaceResultAuthorityFromSourceStatus } from "./authority";

const SOURCE_EXTRACTOR = { id: "race-result-source", version: "5" } as const;

type ResultSourcePaths = NonNullable<RaceResultSourceEvidence["sourcePaths"]>;

function status(available: boolean, availableStatus: RaceResultSourceStatus): RaceResultSourceStatus {
  return available ? availableStatus : "unavailable";
}

/**
 * Lossless result-field reducer for replay/rebuild paths. It consumes the
 * adapter-owned evidence attached to already-projected race observations.
 */
export class RaceSourceAccumulator {
  private frameCount = 0;
  private sessionType: string | null = null;
  private classification: ResultClassification | null = null;
  private classificationSource: RaceResultClaimSource | null = null;
  private finalFinishingPosition: number | null = null;
  private finalQualifyingPosition: number | null = null;
  private latestLiveFinishingPosition: number | null = null;
  private latestLiveQualifyingPosition: number | null = null;
  private isFastestLap: boolean | null = null;
  private fastestLapSource: string | null = null;
  private resultReason: number | null = null;
  private readonly finalClassifications = new Set<ResultClassification>();
  private readonly liveClassifications = new Set<ResultClassification>();
  private readonly sessionTypes = new Map<string, string>();
  private readonly classificationClaims: Array<{
    classification: ResultClassification;
    source: RaceResultClaimSource;
    observedAt: number;
    sequence: number;
  }> = [];
  private readonly sourcePaths: ResultSourcePaths = {};

  private readonly gameId: GameId;

  constructor(gameId: GameId) {
    this.gameId = gameId;
  }

  observe(observation: RaceEventObservation): void {
    const sequence = this.frameCount++;
    const evidence = observation.raceResult;
    if (!evidence) return;
    const observedAt = evidence.observedAtMs != null && Number.isFinite(evidence.observedAtMs) ? evidence.observedAtMs : observation.sourceTimeMs;

    if (evidence.sessionType && evidence.sessionType !== "unknown") {
      this.sessionType = evidence.sessionType;
      this.sessionTypes.set(evidence.sessionType.trim().toLowerCase(), evidence.sessionType);
      if (evidence.sourcePaths?.sessionType) this.sourcePaths.sessionType = evidence.sourcePaths.sessionType;
    }

    const classification = evidence.classification ?? null;
    const classificationSource = evidence.classificationSource ?? "lap-data";
    if (classification != null) {
      this.classificationClaims.push({
        classification,
        source: classificationSource,
        observedAt: Number.isFinite(observedAt) ? observedAt : sequence,
        sequence,
      });
      if (evidence.sourcePaths?.classification) this.sourcePaths.classification = evidence.sourcePaths.classification;
      if (classificationSource === "final-classification") {
        this.finalClassifications.add(classification);
        this.classification = classification;
        this.classificationSource = classificationSource;
        this.resultReason = evidence.resultReason ?? null;
        if (evidence.sourcePaths?.resultReason && this.resultReason != null) {
          this.sourcePaths.resultReason = evidence.sourcePaths.resultReason;
        }
      } else {
        this.liveClassifications.add(classification);
        if (this.classificationSource !== "final-classification") {
          this.classification = classification;
          this.classificationSource = classificationSource;
        }
      }
    }

    const finishingPosition = evidence.finishingPosition;
    if (typeof finishingPosition === "number" && Number.isInteger(finishingPosition) && finishingPosition > 0) {
      if (evidence.finishingPositionSource === "final-classification") {
        this.finalFinishingPosition = finishingPosition;
      } else {
        this.latestLiveFinishingPosition = finishingPosition;
      }
      if (evidence.sourcePaths?.finishingPosition) {
        this.sourcePaths.finishingPosition = evidence.sourcePaths.finishingPosition;
      }
    }

    const qualifyingPosition = evidence.qualifyingPosition;
    if (typeof qualifyingPosition === "number" && Number.isInteger(qualifyingPosition) && qualifyingPosition > 0) {
      if (evidence.qualifyingPositionSource === "final-classification") {
        this.finalQualifyingPosition = qualifyingPosition;
      } else {
        this.latestLiveQualifyingPosition = qualifyingPosition;
      }
      if (evidence.sourcePaths?.qualifyingPosition) {
        this.sourcePaths.qualifyingPosition = evidence.sourcePaths.qualifyingPosition;
      }
    }

    if (typeof evidence.isFastestLap === "boolean") {
      this.isFastestLap = evidence.isFastestLap;
      this.fastestLapSource = evidence.fastestLapSource ?? null;
      if (evidence.sourcePaths?.isFastestLap) this.sourcePaths.isFastestLap = evidence.sourcePaths.isFastestLap;
    }
  }

  /** Preserves player positions already emitted by semantic race-event timeline. */
  observeEvent(event: RaceEvent): void {
    if (event.eventType !== "position_changed" || event.participantKind !== "player") return;
    const position = event.payload.position;
    if (typeof position === "number" && Number.isInteger(position) && position > 0) {
      this.latestLiveFinishingPosition = position;
      this.sourcePaths.finishingPosition = "race-event.position_changed";
    }
  }

  finish(): RaceSourceObservation {
    const finishingPosition = this.finalFinishingPosition ?? this.latestLiveFinishingPosition;
    const qualifyingPosition = this.finalQualifyingPosition ?? this.latestLiveQualifyingPosition;
    const finishingPositionSource: RaceResultClaimSource | null = this.finalFinishingPosition != null ? "final-classification" : finishingPosition != null ? "lap-data" : null;
    const qualifyingPositionSource: RaceResultClaimSource | null = this.finalQualifyingPosition != null ? "final-classification" : qualifyingPosition != null ? "lap-data" : null;
    const selectedClassifications = this.finalClassifications.size > 0 ? this.finalClassifications : this.liveClassifications;
    const conflicts: string[] = [];
    if (selectedClassifications.size > 1) {
      conflicts.push(`classification:${[...selectedClassifications].join("|")}`);
    }
    if (this.sessionTypes.size > 1) {
      conflicts.push(`session-type:${[...this.sessionTypes.values()].join("|")}`);
    }
    const fieldStatus: RaceResultEvidence["fieldStatus"] = {
      sessionType: status(this.sessionType != null, "direct"),
      classification: status(this.classification != null, this.classificationSource === "final-classification" ? "direct" : "simplified"),
      finishingPosition: status(finishingPosition != null, finishingPositionSource === "final-classification" ? "direct" : "simplified"),
      qualifyingPosition: status(qualifyingPosition != null, qualifyingPositionSource === "final-classification" ? "direct" : "simplified"),
      isPodium: "unavailable",
      isFastestLap: status(this.isFastestLap != null, "derived"),
      pitTimeline: "unavailable",
      tyreStrategy: "unavailable",
      fuelStrategy: "unavailable",
    };
    const provenance = createRaceResultProvenance(this.gameId, {
      extractor: SOURCE_EXTRACTOR,
      fields: {
        sessionType: this.sessionType == null ? null : (this.sourcePaths.sessionType ?? null),
        classification: this.classification == null ? null : (this.sourcePaths.classification ?? null),
        finishingPosition: finishingPosition == null ? null : (this.sourcePaths.finishingPosition ?? null),
        qualifyingPosition: qualifyingPosition == null ? null : (this.sourcePaths.qualifyingPosition ?? null),
        isFastestLap: this.isFastestLap == null ? null : (this.sourcePaths.isFastestLap ?? null),
        pitTimeline: null,
        tyreStrategy: null,
        fuelStrategy: null,
        resultReason: this.resultReason == null ? null : (this.sourcePaths.resultReason ?? null),
      },
    });
    return {
      gameId: this.gameId,
      sessionType: this.sessionType,
      classification: this.classification,
      finishingPosition,
      qualifyingPosition,
      isFastestLap: this.isFastestLap,
      fastestLapSource: this.fastestLapSource,
      claims: this.classificationClaims.map(
        (claim) =>
          ({
            id: `classification:${claim.source}:${claim.sequence}`,
            claimId: "race-result.classification",
            entityId: `${this.gameId}:player`,
            validFrom: 0,
            validTo: Number.MAX_SAFE_INTEGER,
            value: claim.classification,
            authority: resolveRaceResultAuthorityFromSourceStatus(claim.source === "final-classification" ? "direct" : "simplified"),
            kind: "deterministic",
            confidence: claim.source === "final-classification" ? 1 : 0.7,
            observedAt: claim.observedAt,
            valid: true,
            applicable: true,
            validated: true,
            provenance,
          }) satisfies RaceResultClaimEvidence,
      ),
      tyreStrategy: null,
      fuelStrategy: null,
      provenance,
      evidence: { fieldStatus, conflicts },
      reasons: [],
    };
  }
}
