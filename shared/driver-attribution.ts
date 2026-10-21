import type { GameId } from "./games/ids";

export type DriverAttribution = "Self" | "Other" | "Unknown";
export type LapDriverAttribution = DriverAttribution | "Mixed";

/** Measured duration allocation; source-clock coverage stays distinct from raw elapsed time. */
export interface DriverDurationAttribution {
  selfSeconds: number;
  otherSeconds: number;
  unknownSeconds: number;
  selfObserved: boolean;
  coverage: "complete" | "partial" | "unavailable";
}

export interface NativeDriverSourceCapability {
  gameId: GameId;
  source: string;
  nativeActorEvidence: string | null;
  stintBoundaryEvidence: string | null;
  limitation: string;
}

/** Native actor token and source clock; never a display name or car/player slot. */
export interface NativeDriverActor {
  gameId: GameId;
  source: string;
  actorId: string;
  /** Session IDs must be rebound each session; installation IDs may be bound globally. */
  bindingScope: "session" | "installation";
  sessionId: string;
  clockDomain: string;
  observedAtMs: number;
  /** Earliest source-clock expiry when native evidence components have different cadences. */
  evidenceExpiresAtMs?: number;
}

/** Immutable local binding captured with source evidence; remote registration revisions are separate. */
export interface CapturedDriverBinding {
  readonly id: string;
  readonly gameId: GameId;
  readonly sourceKind: string;
  readonly nativeIdentity: string;
  readonly confirmation: "native_verified" | "user_confirmed";
  readonly revision: number;
}

export interface ResolvedDriverAttribution {
  attribution: DriverAttribution;
  bindingRevision: number | null;
  bindingSnapshot?: CapturedDriverBinding;
}

/** Confirmed relationship between one native actor and this installation user. */
export interface DriverActorBinding {
  gameId: GameId;
  source: string;
  actorId: string;
  /** Session scope for source IDs that are not stable across sessions. */
  sessionId?: string;
  revision: number;
  snapshot?: CapturedDriverBinding;
}

/** Portable source-clock interval; actor may be absent while source/session provenance remains. */
export interface DriverAttributionStint {
  gameId: GameId;
  source: string;
  sessionId: string;
  startMs: number;
  endMs: number | null;
  /** Last source-clock time covered by fresh evidence. */
  evidenceValidUntilMs: number;
  clockDomain: string;
  actor: NativeDriverActor | null;
  attribution: DriverAttribution;
  bindingRevision: number | null;
  /** Original descriptor/confirmation survives replacement of the current per-game binding row. */
  bindingSnapshot?: CapturedDriverBinding;
}

export interface DriverAttributionObservation {
  actor: NativeDriverActor | null;
  gameId: GameId;
  source: string;
  sessionId: string;
  clockDomain: string;
  observedAtMs: number;
  bindings: readonly DriverActorBinding[];
  maxAgeMs: number;
}

export interface DriverAttributionStintInput extends DriverAttributionObservation {
  startMs: number;
  endMs: number | null;
  evidenceValidUntilMs: number;
}

function matchesCapturedBinding(snapshot: CapturedDriverBinding, gameId: GameId, source: string, revision: number | null): boolean {
  return snapshot !== null && typeof snapshot === "object" && typeof snapshot.id === "string" && snapshot.id.length > 0 &&
    snapshot.gameId === gameId && snapshot.sourceKind === source &&
    typeof snapshot.nativeIdentity === "string" && snapshot.nativeIdentity.length > 0 &&
    (snapshot.confirmation === "native_verified" || snapshot.confirmation === "user_confirmed") &&
    Number.isSafeInteger(snapshot.revision) && snapshot.revision > 0 && snapshot.revision === revision;
}

/** Missing, stale, invalid, unbound, or conflicting facts stay Unknown. */
export function resolveDriverAttribution(
  observation: DriverAttributionObservation,
): ResolvedDriverAttribution {
  const { actor, gameId, source, sessionId, clockDomain, observedAtMs, bindings, maxAgeMs } = observation;
  if (!actor || !gameId || actor.gameId !== gameId || !source || actor.source !== source ||
      !sessionId || actor.sessionId !== sessionId || !clockDomain || actor.clockDomain !== clockDomain ||
      !Number.isFinite(observedAtMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 ||
      !Number.isFinite(actor.observedAtMs) || actor.observedAtMs > observedAtMs ||
      observedAtMs - actor.observedAtMs > maxAgeMs || !actor.actorId ||
      (actor.evidenceExpiresAtMs !== undefined &&
        (!Number.isFinite(actor.evidenceExpiresAtMs) || observedAtMs > actor.evidenceExpiresAtMs)) ||
      (actor.bindingScope !== "session" && actor.bindingScope !== "installation")) {
    return { attribution: "Unknown", bindingRevision: null };
  }
  let binding: DriverActorBinding | null = null;
  for (const candidate of bindings) {
    if (candidate.gameId !== actor.gameId || candidate.source !== actor.source ||
        (candidate.sessionId !== undefined && candidate.sessionId !== actor.sessionId) ||
        (actor.bindingScope === "session" && candidate.sessionId !== actor.sessionId)) continue;
    if (binding) return { attribution: "Unknown", bindingRevision: null };
    binding = candidate;
  }
  if (!binding) return { attribution: "Unknown", bindingRevision: null };
  if (!binding.actorId || !Number.isInteger(binding.revision) || binding.revision < 1) {
    return { attribution: "Unknown", bindingRevision: null };
  }
  if (binding.snapshot && !matchesCapturedBinding(binding.snapshot, gameId, source, binding.revision)) {
    return { attribution: "Unknown", bindingRevision: null };
  }
  return {
    attribution: binding.actorId === actor.actorId ? "Self" : "Other",
    bindingRevision: binding.revision,
    ...(binding.snapshot ? { bindingSnapshot: binding.snapshot } : {}),
  };
}

/** Capture one validated source observation as portable attribution evidence. */
export function makeDriverAttributionStint(
  input: DriverAttributionStintInput,
): DriverAttributionStint {
  const resolved = resolveDriverAttribution(input);
  return {
    gameId: input.gameId,
    source: input.source,
    sessionId: input.sessionId,
    startMs: input.startMs,
    endMs: input.endMs,
    evidenceValidUntilMs: input.evidenceValidUntilMs,
    clockDomain: input.clockDomain,
    actor: input.actor,
    ...resolved,
  };
}

/** Classify complete lap interval; invalid clocks, gaps, overlaps, or Unknown remain Unknown. */
export function classifyLapAttribution(
  stints: readonly DriverAttributionStint[],
  lapStartMs: number,
  lapEndMs: number,
  clockDomain: string,
): LapDriverAttribution {
  if (!clockDomain || !Number.isFinite(lapStartMs) || !Number.isFinite(lapEndMs) || lapEndMs <= lapStartMs) {
    return "Unknown";
  }
  let coveredUntil = lapStartMs;
  let sawSelf = false;
  let sawOther = false;
  let sourceContext: DriverAttributionStint | null = null;
  let firstActorId: string | null = null;
  let sawActorSwap = false;
  for (const stint of stints) {
    if (!stint.gameId || !stint.source || !stint.sessionId || !stint.clockDomain ||
        !Number.isFinite(stint.startMs) || (stint.endMs !== null &&
        (!Number.isFinite(stint.endMs) || stint.endMs <= stint.startMs))) return "Unknown";
    if (stint.bindingSnapshot && !matchesCapturedBinding(stint.bindingSnapshot, stint.gameId, stint.source, stint.bindingRevision)) return "Unknown";
    if (stint.attribution !== "Unknown" &&
        (!stint.actor || stint.actor.gameId !== stint.gameId || stint.actor.source !== stint.source ||
          stint.actor.sessionId !== stint.sessionId || stint.actor.clockDomain !== stint.clockDomain ||
          !stint.actor.actorId || typeof stint.bindingRevision !== "number" ||
          !Number.isInteger(stint.bindingRevision) || stint.bindingRevision < 1)) {
      return "Unknown";
    }
    if (stint.actor && (stint.actor.gameId !== stint.gameId || stint.actor.source !== stint.source ||
        stint.actor.sessionId !== stint.sessionId || stint.actor.clockDomain !== stint.clockDomain ||
        !stint.actor.actorId || !Number.isFinite(stint.actor.observedAtMs) ||
        (stint.actor.bindingScope !== "session" && stint.actor.bindingScope !== "installation"))) {
      return "Unknown";
    }
    if (stint.endMs !== null && stint.endMs <= lapStartMs) continue;
    if (stint.startMs >= lapEndMs) break;
    const endMs = stint.endMs ?? lapEndMs;
    if (stint.clockDomain !== clockDomain || stint.startMs > coveredUntil ||
        !Number.isFinite(stint.evidenceValidUntilMs) ||
        stint.evidenceValidUntilMs < Math.min(lapEndMs, endMs) || endMs <= coveredUntil ||
        (stint.startMs < coveredUntil && coveredUntil !== lapStartMs)) return "Unknown";
    if (stint.attribution === "Unknown") return "Unknown";
    if (sourceContext && (sourceContext.gameId !== stint.gameId || sourceContext.source !== stint.source ||
      sourceContext.sessionId !== stint.sessionId)) return "Unknown";
    sourceContext ??= stint;
    const actorId = stint.actor!.actorId;
    if (firstActorId !== null && firstActorId !== actorId) sawActorSwap = true;
    firstActorId ??= actorId;
    sawSelf ||= stint.attribution === "Self";
    sawOther ||= stint.attribution === "Other";
    coveredUntil = Math.min(lapEndMs, endMs);
    if (coveredUntil >= lapEndMs) {
      if (sawActorSwap || (sawSelf && sawOther)) return "Mixed";
      return sawSelf ? "Self" : sawOther ? "Other" : "Unknown";
    }
  }
  return "Unknown";
}

/** Whole logical lap is eligible for personal completion/upload only as Self. */
export function isWholeLapSelf(
  stints: readonly DriverAttributionStint[],
  lapStartMs: number,
  lapEndMs: number,
  clockDomain: string,
): boolean {
  return classifyLapAttribution(stints, lapStartMs, lapEndMs, clockDomain) === "Self";
}
