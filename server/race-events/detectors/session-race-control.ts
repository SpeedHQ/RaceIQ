import type { CautionKind, RaceSessionPhase } from "../../../shared/racing/events/contracts";
import type { RaceEventObservation } from "../../games/types";
import { EVENT_ORDER_PRIORITY, type DetectorContext, type DetectorEventDraft } from "../types";

export const SESSION_RACE_CONTROL_DETECTOR_ID = "race-control";
export const SESSION_RACE_CONTROL_DETECTOR_VERSION = "3";

function draft(context: DetectorContext, eventType: DetectorEventDraft["eventType"], payload: DetectorEventDraft["payload"], suffix: string = eventType ?? "event"): DetectorEventDraft {
  return {
    eventType,
    payload,
    detectorId: SESSION_RACE_CONTROL_DETECTOR_ID,
    detectorVersion: SESSION_RACE_CONTROL_DETECTOR_VERSION,
    priority: EVENT_ORDER_PRIORITY.sessionRaceControl,
    boundaryKey: `${context.boundaryKey}:${suffix}`,
    evidenceKind: "observed",
    confidence: "high",
    qualityState: "available",
  } as DetectorEventDraft;
}

function provesCaution(observation: RaceEventObservation): boolean {
  return observation.sessionPhase === "caution" && observation.raceControlEvidence === "authoritative";
}

function canEndCaution(observation: RaceEventObservation): boolean {
  if (observation.raceControlEvidence !== "authoritative") return false;
  const phase = observation.sessionPhase;
  return phase === "red" || phase === "checkered" || phase === "finished";
}

function provesGreen(observation: RaceEventObservation): boolean {
  return observation.sessionPhase === "green" && observation.raceControlEvidence === "authoritative";
}

function provesRed(observation: RaceEventObservation): boolean {
  return observation.sessionPhase === "red" && observation.raceControlEvidence === "authoritative";
}

function provesCheckered(observation: RaceEventObservation): boolean {
  return observation.sessionPhase === "checkered" && observation.raceControlEvidence === "authoritative";
}

export class SessionRaceControlDetector {
  private phase: RaceSessionPhase = "unknown";
  private cautionKind: CautionKind | null = null;
  private redActive = false;
  private checkeredActive = false;
  private restartPending = false;
  private ended = false;

  reset(): void {
    this.phase = "unknown";
    this.cautionKind = null;
    this.redActive = false;
    this.checkeredActive = false;
    this.ended = false;
    this.restartPending = false;
  }

  startSession(context: DetectorContext, reason: string): DetectorEventDraft[] {
    const observation = context.observation;
    const phase = observation.sessionPhase;
    this.ended = false;
    this.seed(observation);
    const events: DetectorEventDraft[] = [
      draft(
        context,
        "session_started",
        {
          phase,
          previousPhase: null,
          reason,
          gridStart: observation.gridStart === true,
          nativeCode: observation.nativeRaceControlCode,
        },
        `session-start:${reason}`,
      ),
    ];
    if (provesCaution(observation)) {
      events.push(
        draft(context, "caution_started", {
          kind: observation.cautionKind,
          nativeCode: observation.nativeRaceControlCode,
        }),
      );
    }
    if (provesGreen(observation)) {
      events.push(
        draft(context, "green_flag", {
          nativeCode: observation.nativeRaceControlCode,
        }),
      );
    }
    if (provesRed(observation)) {
      events.push(
        draft(context, "red_flag_started", {
          nativeCode: observation.nativeRaceControlCode,
        }),
      );
    }
    if (provesCheckered(observation)) {
      events.push(
        draft(context, "checkered_flag", {
          nativeCode: observation.nativeRaceControlCode,
        }),
      );
    }
    if (observation.terminalObserved === true) {
      events.push(
        draft(
          context,
          "session_ended",
          {
            phase: "finished",
            previousPhase: phase,
            reason: "terminal-observed",
            terminalObserved: true,
            nativeCode: observation.nativeRaceControlCode,
          },
          "session-end:terminal-observed",
        ),
      );
      this.phase = "finished";
      this.ended = true;
    }
    return events;
  }

  endSession(context: DetectorContext, input: { reason: string; terminalObserved: boolean }): DetectorEventDraft[] {
    if (this.ended) return [];
    const previousPhase = this.phase;
    const phase = input.terminalObserved ? "finished" : previousPhase;
    this.phase = phase;
    this.ended = true;
    return [
      draft(
        context,
        "session_ended",
        {
          phase,
          previousPhase,
          reason: input.reason,
          terminalObserved: input.terminalObserved,
          nativeCode: context.observation.nativeRaceControlCode,
        },
        `session-end:${input.reason}`,
      ),
    ];
  }

  observe(context: DetectorContext): DetectorEventDraft[] {
    const observation = context.observation;
    if (context.seed) {
      this.seed(observation);
      return [];
    }

    const events: DetectorEventDraft[] = [];
    const previousPhase = this.phase;
    const hadCaution = this.cautionKind != null;
    const directCaution = provesCaution(observation);
    const directGreen = provesGreen(observation);
    const directRed = provesRed(observation);
    const directCheckered = provesCheckered(observation);
    if (
      hadCaution &&
      observation.raceControlEvidence === "authoritative" &&
      observation.sessionPhase === "formation"
    ) {
      this.restartPending = true;
    }

    if (hadCaution && !directCaution && (directGreen || canEndCaution(observation))) {
      events.push(
        draft(context, "caution_ended", {
          kind: this.cautionKind ?? "unknown",
          nativeCode: observation.nativeRaceControlCode,
        }),
      );
      this.cautionKind = null;
      this.restartPending = directGreen;
      if (observation.sessionPhase === "unknown") this.phase = "unknown";
    }

    if (directCaution) {
      this.restartPending = false;
      if (this.cautionKind == null || this.cautionKind !== observation.cautionKind) {
        events.push(
          draft(context, "caution_started", {
            kind: observation.cautionKind,
            nativeCode: observation.nativeRaceControlCode,
          }),
        );
      }
      this.cautionKind = observation.cautionKind;
    }

    if (directGreen && previousPhase !== "green") {
      if (hadCaution || this.restartPending) {
        events.push(
          draft(context, "restart_started", {
            nativeCode: observation.nativeRaceControlCode,
          }),
        );
      }
      this.restartPending = false;
      events.push(
        draft(context, "green_flag", {
          nativeCode: observation.nativeRaceControlCode,
        }),
      );
    }
    if (directRed && !this.redActive) {
      events.push(
        draft(context, "red_flag_started", {
          nativeCode: observation.nativeRaceControlCode,
        }),
      );
    }
    if (directCheckered && !this.checkeredActive) {
      events.push(
        draft(context, "checkered_flag", {
          nativeCode: observation.nativeRaceControlCode,
        }),
      );
    }

    if (observation.sessionPhase !== "unknown" && observation.sessionPhase !== this.phase) {
      events.push(
        draft(context, "session_phase_changed", {
          phase: observation.sessionPhase,
          previousPhase: this.phase,
          reason: null,
          nativeCode: observation.nativeRaceControlCode,
        }),
      );
      this.phase = observation.sessionPhase;
    }
    if (observation.terminalObserved === true && !this.ended) {
      events.push(
        draft(
          context,
          "session_ended",
          {
            phase: "finished",
            previousPhase,
            reason: "terminal-observed",
            terminalObserved: true,
            nativeCode: observation.nativeRaceControlCode,
          },
          "session-end:terminal-observed",
        ),
      );
      this.phase = "finished";
      this.ended = true;
    }
    if (observation.sessionPhase !== "unknown") this.redActive = directRed;
    this.checkeredActive ||= directCheckered;
    if (directRed || directCheckered || observation.sessionPhase === "finished") {
      this.restartPending = false;
    }
    return events;
  }

  currentPhase(): RaceSessionPhase {
    return this.phase;
  }

  currentCautionKind(): CautionKind | null {
    return this.cautionKind;
  }

  hasEnded(): boolean {
    return this.ended;
  }

  private seed(observation: RaceEventObservation): void {
    if (observation.sessionPhase !== "unknown") {
      this.phase = observation.sessionPhase;
    }
    if (provesCaution(observation)) {
      this.cautionKind = observation.cautionKind;
    }
    this.redActive = provesRed(observation);
    this.checkeredActive = provesCheckered(observation);
  }
}
