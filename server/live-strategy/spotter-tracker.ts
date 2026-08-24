import type { SpotterEventV1, SpotterFrameV1, SpotterOpponentPoseV1 } from "../../shared/racing/live/spotter-contracts";

export interface SpotterTrackerOptions {
  overlapDelayMs?: number;
  clearDelayMs?: number;
  stillThereMs?: number;
  staleStateMs?: number;
  maxClosingSpeedMps?: number;
  trackZoneM?: number;
  behindExtraLengthM?: number;
}
export interface NativeSpotterFrame {
  sessionId: string;
  timelineEpoch: number;
  sourceSequence: number;
  sessionTimeMs: number;
  carLeftRight: number;
}

type SideState = { ids: Set<string>; lastOverlapMs: number; lastStillThereMs: number; announced: boolean };
const emptySide = (): SideState => ({ ids: new Set(), lastOverlapMs: -Infinity, lastStillThereMs: -Infinity, announced: false });

export class SpotterTracker {
  private readonly options: Required<SpotterTrackerOptions>;
  private readonly sides = { left: emptySide(), right: emptySide() };
  private lastSession: string | undefined;
  private lastEpoch = -1;

  constructor(options: SpotterTrackerOptions = {}) {
    this.options = { overlapDelayMs: 0, clearDelayMs: 500, stillThereMs: 3_000, staleStateMs: 5_000, maxClosingSpeedMps: 20, trackZoneM: 20, behindExtraLengthM: 0.4, ...options };
  }

  reset(): void { this.sides.left.ids.clear(); this.sides.right.ids.clear(); this.sides.left.announced = false; this.sides.right.announced = false; }

  update(frame: SpotterFrameV1): SpotterEventV1[] {
    if (this.lastSession !== frame.sessionId || this.lastEpoch !== frame.timelineEpoch) { this.reset(); this.lastSession = frame.sessionId; this.lastEpoch = frame.timelineEpoch; }
    if (frame.formationLap || frame.pitContext || frame.cautionContext || !Number.isFinite(frame.player.speedMps) || frame.player.speedMps < 2.78) return this.suppress(frame);
    const current = { left: new Map<string, number>(), right: new Map<string, number>() };
    for (const opponent of frame.opponents) {
      const relative = aligned(frame, opponent);
      if (!Number.isFinite(relative.x) || !Number.isFinite(relative.z) || Math.abs(relative.x) > this.options.trackZoneM) continue;
      const inLongitudinalWindow = relative.z < 0 ? -relative.z < frame.player.lengthM : relative.z < frame.player.lengthM + this.options.behindExtraLengthM;
      if (!inLongitudinalWindow || Math.abs(relative.x) <= frame.player.widthM) continue;
      if (opponent.speedMps !== undefined && Math.abs(opponent.speedMps - frame.player.speedMps) > this.options.maxClosingSpeedMps) continue;
      (relative.x >= 0 ? current.left : current.right).set(opponent.id, Math.abs(relative.x));
    }
    return [this.transition("left", current.left, frame), this.transition("right", current.right, frame)].flat();
  }

  private suppress(frame: SpotterFrameV1): SpotterEventV1[] {
    const events: SpotterEventV1[] = [];
    for (const side of ["left", "right"] as const) { const state = this.sides[side]; if (state.ids.size) { state.ids.clear(); state.lastOverlapMs = frame.sessionTimeMs; } }
    return events;
  }
  updateNative(frame: NativeSpotterFrame): SpotterEventV1[] {
    if (this.lastSession !== frame.sessionId || this.lastEpoch !== frame.timelineEpoch) {
      this.reset();
      this.lastSession = frame.sessionId;
      this.lastEpoch = frame.timelineEpoch;
    }
    const meta = { sessionId: frame.sessionId, timelineEpoch: frame.timelineEpoch, sourceSequence: frame.sourceSequence, sessionTimeMs: frame.sessionTimeMs, player: { x: 0, z: 0, rotationRad: 0, speedMps: 20, widthM: 1.8, lengthM: 4.8 }, opponents: [] as SpotterOpponentPoseV1[] };
    const left = new Map<string, number>();
    const right = new Map<string, number>();
    if (frame.carLeftRight === 2) left.set("native-left", 1);
    else if (frame.carLeftRight === 3) right.set("native-right", 1);
    else if (frame.carLeftRight === 4) { left.set("native-left", 1); right.set("native-right", 1); }
    else if (frame.carLeftRight === 5) { left.set("native-left-1", 1); left.set("native-left-2", 2); }
    else if (frame.carLeftRight === 6) { right.set("native-right-1", 1); right.set("native-right-2", 2); }
    else if (frame.carLeftRight !== 0 && frame.carLeftRight !== 1) return this.suppress(meta);
    return [this.transition("left", left, meta), this.transition("right", right, meta)].flat();
  }

  private transition(side: "left" | "right", current: Map<string, number>, frame: SpotterFrameV1): SpotterEventV1[] {
    const state = this.sides[side]; const events: SpotterEventV1[] = []; const wasOverlapping = state.ids.size > 0; const nowOverlapping = current.size > 0;
    if (nowOverlapping) {
      const enteredAt = frame.sessionTimeMs;
      if (!wasOverlapping && enteredAt >= state.lastOverlapMs + this.options.overlapDelayMs) {
        state.announced = true;
        events.push(this.event(side === "left" ? "car-left" : "car-right", side, current, frame));
      } else if (state.announced && frame.sessionTimeMs - state.lastStillThereMs >= this.options.stillThereMs) {
        state.lastStillThereMs = frame.sessionTimeMs;
        if (current.size >= 2) events.push(this.event(side === "left" ? "three-wide-left" : "three-wide-right", side, current, frame));
        else events.push(this.event("still-there", side, current, frame));
      }
      if (!wasOverlapping) state.lastStillThereMs = frame.sessionTimeMs;
      state.lastOverlapMs = frame.sessionTimeMs;
      state.ids = new Set(current.keys());
    } else if (wasOverlapping) {
      if (state.announced && frame.sessionTimeMs - state.lastOverlapMs >= this.options.clearDelayMs) {
        events.push(this.event(side === "left" ? "clear-left" : "clear-right", side, new Map(), frame));
        state.announced = false;
        state.ids.clear();
      }
    } else if (state.announced && frame.sessionTimeMs - state.lastOverlapMs >= this.options.staleStateMs) {
      state.announced = false;
    }
    return events;
  }

  private event(state: SpotterEventV1["state"], side: "left" | "right", ids: Map<string, number>, frame: SpotterFrameV1): SpotterEventV1 {
    return { state, side, overlapCount: ids.size, sourceSequence: frame.sourceSequence, sessionTimeMs: frame.sessionTimeMs, opponentIds: [...ids.keys()].sort() };
  }
}

function aligned(frame: SpotterFrameV1, opponent: SpotterOpponentPoseV1): { x: number; z: number } {
  const dx = opponent.x - frame.player.x; const dz = opponent.z - frame.player.z;
  return { x: Math.cos(frame.player.rotationRad) * dx + Math.sin(frame.player.rotationRad) * dz, z: Math.cos(frame.player.rotationRad) * dz - Math.sin(frame.player.rotationRad) * dx };
}
