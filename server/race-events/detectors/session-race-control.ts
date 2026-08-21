import type { CautionKind, RaceSessionPhase } from "../../../shared/racing/events/contracts";
import type { RaceEventObservation } from "../../games/types";
import { EVENT_ORDER_PRIORITY, type DetectorContext, type DetectorEventDraft } from "../types";

export const SESSION_RACE_CONTROL_DETECTOR_ID = "race-control";
export const SESSION_RACE_CONTROL_DETECTOR_VERSION = "2";

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

function canEndCaution(observation: RaceEventObservation): boolean {
  const code = observation.nativeRaceControlCode;
  if (observation.gameId === "f1-2025") return code === 0;
  if (observation.gameId === "acc") {
    return typeof code === "string" && code.toLowerCase() === "none";
  }
  if (observation.gameId === "ac-evo") {
    return observation.sessionPhase === "green" || observation.sessionPhase === "red" || observation.sessionPhase === "checkered";
  }
  return false;
}

function provesGreen(observation: RaceEventObservation): boolean {
  if (observation.sessionPhase !== "green") return false;
  return observation.gameId === "ac-evo" || observation.gameId === "f1-2025";
}

function provesCheckered(observation: RaceEventObservation): boolean {
  return observation.sessionPhase === "checkered" && (observation.gameId === "acc" || observation.gameId === "ac-evo");
}

export class SessionRaceControlDetector {
  private phase: RaceSessionPhase = "unknown";
  private cautionKind: CautionKind | null = null;
  private redActive = false;
  private checkeredActive = false;
  private ended = false;

  reset(): void {
    this.phase = "unknown";
    this.cautionKind = null;
    this.redActive = false;
    this.checkeredActive = false;
    this.ended = false;
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
    if (phase === "caution") {
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
    if (observation.gameId === "ac-evo" && phase === "red") {
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
    const directCaution = observation.sessionPhase === "caution";
    const directGreen = provesGreen(observation);
    const directRed = observation.gameId === "ac-evo" && observation.sessionPhase === "red";
    const directCheckered = provesCheckered(observation);

    if (hadCaution && !directCaution && (directGreen || canEndCaution(observation))) {
      events.push(
        draft(context, "caution_ended", {
          kind: this.cautionKind ?? "unknown",
          nativeCode: observation.nativeRaceControlCode,
        }),
      );
      this.cautionKind = null;
      if (observation.sessionPhase === "unknown") this.phase = "unknown";
    }

    if (directCaution) {
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
      if (hadCaution) {
        events.push(
          draft(context, "restart_started", {
            nativeCode: observation.nativeRaceControlCode,
          }),
        );
      }
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
    if (observation.sessionPhase === "caution") {
      this.cautionKind = observation.cautionKind;
    }
    this.redActive = observation.gameId === "ac-evo" && observation.sessionPhase === "red";
    this.checkeredActive = provesCheckered(observation);
  }
}
