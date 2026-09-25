import type { GameId } from "../../../shared/games/ids";
import type { ResolvedValue } from "../../../shared/telemetry/resolver/contracts";
import type { LiveResolvedSemanticFrame } from "../../telemetry/live-projector";
import type { CrewChiefTriggerContextV1 } from "./contracts";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const boolish = (value: unknown): boolean => typeof value === "boolean" ? value : typeof value === "number" ? value !== 0 : typeof value === "string" && ["true", "active", "caution", "yellow", "red", "pit"].includes(value.toLowerCase());
const pitStatus = (value: unknown): boolean => value === true || (typeof value === "string" && ["in_pit", "pit_lane", "pit", "pit-stall"].includes(value.toLowerCase()));
const cautionStatus = (id: string, value: unknown): boolean => id === "race.safety-car-status" ? (finite(value) ? value !== 0 : value === true) : id === "session.session-flags" ? finite(value) && (value & ((1 << 5) | (1 << 6) | (1 << 7) | (1 << 8) | (1 << 9))) !== 0 : typeof value === "string" ? ["yellow", "red", "caution"].includes(value.toLowerCase()) : value === true;

export class CrewChiefTriggerFrame {
  readonly simulator: GameId;
  readonly sessionId: string;
  readonly streamId: string;
  readonly sequence: number;
  private readonly slots: Readonly<Record<string, number>>;
  readonly source: LiveResolvedSemanticFrame;
  constructor(source: LiveResolvedSemanticFrame) {
    this.source = source;
    this.simulator = source.simulator;
    this.sessionId = String(source.sessionId ?? "");
    this.streamId = source.streamId;
    this.sequence = source.sequence;
    const slots: Record<string, number> = {};
    source.ids.forEach((id, index) => { slots[id] = index; });
    this.slots = slots;
  }
  resolved<T = unknown>(id: string): ResolvedValue<T> | undefined { const slot = this.slots[id]; return slot === undefined ? undefined : this.source.values[slot] as ResolvedValue<T>; }
  ok<T = unknown>(id: string): T | undefined { const value = this.resolved<T>(id); return value?.state === "ok" ? value.value ?? undefined : undefined; }
  hasFresh(id: string): boolean { const value = this.resolved(id); return value?.state === "ok" && value.freshness === "fresh"; }
  context(): CrewChiefTriggerContextV1 {
    const phase = this.ok<unknown>("session.session-state");
    const pit = pitStatus(this.ok("race.pit-status")) || boolish(this.ok("race.on-pit-road"));
    return { simulator: this.simulator, sessionActive: phase !== undefined && phase !== 0, formation: phase === 2 || phase === 3 || phase === 4, caution: ["race.safety-car-status", "race.flag-status", "session.session-flags"].some((id) => { const value = this.resolved(id); return value?.state === "ok" && cautionStatus(id, value.value); }), pit, spectating: boolish(this.ok("session.is-spectating")) };
  }
}
