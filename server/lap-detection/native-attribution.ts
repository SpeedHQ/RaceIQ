import { randomUUID } from "node:crypto";
import type { GameIdentityBinding, GameIdentityCandidate } from "@raceiq/online/contracts";
import { F1_HEADER_SIZE, F1_PACKET_IDS } from "@raceiq/capture-formats/f1-2025/f1-wire";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { GameIdSchema, type GameId } from "@raceiq/shared/games/ids";
import { classifyLapAttribution, resolveDriverAttribution, type CapturedDriverBinding, type DriverActorBinding, type DriverAttributionStint, type LapDriverAttribution, type NativeDriverActor } from "@raceiq/shared/driver-attribution";

export interface NativeSourceClock {
  domain: string;
  atMs: number;
  sessionId: string;
  source: string;
}
export interface NativeBindingDescriptor {
  schemaVersion: 1;
  actorId: string;
  bindingScope: "session" | "installation";
  sessionId?: string;
}

/** A session-scoped token is never promoted to an installation-wide identity. */
export function encodeNativeDriverBinding(actor: NativeDriverActor): string {
  return JSON.stringify({ schemaVersion: 1, actorId: actor.actorId, bindingScope: actor.bindingScope,
    ...(actor.bindingScope === "session" ? { sessionId: actor.sessionId } : {}) } satisfies NativeBindingDescriptor);
}
export function decodeNativeDriverBinding(nativeIdentity: string): NativeBindingDescriptor | null {
  try {
    const value: unknown = JSON.parse(nativeIdentity);
    if (!value || typeof value !== "object" || !("schemaVersion" in value) || value.schemaVersion !== 1 ||
      !("actorId" in value) || typeof value.actorId !== "string" || !value.actorId ||
      !("bindingScope" in value) || (value.bindingScope !== "session" && value.bindingScope !== "installation")) return null;
    if (value.bindingScope === "session" && (!("sessionId" in value) || typeof value.sessionId !== "string" || !value.sessionId)) return null;
    return { schemaVersion: 1, actorId: value.actorId, bindingScope: value.bindingScope,
      ...(value.bindingScope === "session" && "sessionId" in value && typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}) };
  } catch { return null; }
}
function validSourceDescriptor(gameId: string, source: string, descriptor: NativeBindingDescriptor): boolean {
  if (gameId === "f1-2025") {
    if (descriptor.bindingScope !== "session" || !descriptor.sessionId || !/^[1-9]\d*$/.test(descriptor.sessionId)) return false;
    if (source === "f1-2025-udp-local-controller") return descriptor.actorId === `${descriptor.sessionId}:local-player`;
    if (source !== "f1-2025-udp-participant") return false;
    const prefix = `${descriptor.sessionId}:network:`;
    const networkId = descriptor.actorId.startsWith(prefix) ? descriptor.actorId.slice(prefix.length) : "";
    return /^(?:0|[1-9]\d{0,2})$/.test(networkId) && Number(networkId) < 255;
  }
  if (descriptor.bindingScope !== "installation") return false;
  if (gameId === "ac-evo") return source === "ac-evo-shared-memory" && descriptor.actorId === "ac-evo-control:local-player";
  if (gameId === "lmu") return source === "lmu-shared-memory-player-scoring" && descriptor.actorId === "lmu-control:0";
  if (gameId === "iracing") return source === "iracing-sdk-session-info" && /^[1-9]\d*$/.test(descriptor.actorId);
  // ACC/Forza currently expose no native human/controller token that a binding could confirm.
  return false;
}

/** Reject display names, slots, AI/remote control roles and promoted session-scoped tokens. */
export function validateNativeDriverBinding(binding: Pick<GameIdentityBinding, "gameId" | "sourceKind" | "nativeIdentity">): boolean {
  const descriptor = decodeNativeDriverBinding(binding.nativeIdentity);
  return descriptor !== null && validSourceDescriptor(binding.gameId, binding.sourceKind, descriptor);
}

export function nativeDriverBindings(bindings: readonly GameIdentityBinding[]): DriverActorBinding[] {
  const result: DriverActorBinding[] = [];
  for (const binding of bindings) {
    const descriptor = decodeNativeDriverBinding(binding.nativeIdentity);
    const gameId = GameIdSchema.safeParse(binding.gameId);
    if (!descriptor || !gameId.success || !validSourceDescriptor(binding.gameId, binding.sourceKind, descriptor) ||
      !Number.isSafeInteger(binding.revision) || binding.revision < 1 ||
      (binding.confirmation !== "native_verified" && binding.confirmation !== "user_confirmed")) continue;
    result.push({ gameId: gameId.data, source: binding.sourceKind, actorId: descriptor.actorId,
      sessionId: descriptor.sessionId, revision: binding.revision,
      snapshot: { id: binding.id, gameId: gameId.data, sourceKind: binding.sourceKind, nativeIdentity: binding.nativeIdentity,
        confirmation: binding.confirmation, revision: binding.revision } });
  }
  return result;
}

/** Recorder UTC is explicit source evidence, not simulator elapsed time or replay wall time. */
export function getNativeSourceClock(packet: TelemetryPacket, explicitFrameTimeMs?: number): NativeSourceClock | null {
  const actor = packet.driverActor;
  const sessionId = (packet.gameId === "ac-evo" ? actor?.sessionId ?? packet.sessionUID : packet.sessionUID ?? actor?.sessionId) ??
    ((packet.gameId === "acc" || packet.gameId === "ac-evo") ? `${packet.gameId}:capture-observation` : undefined);
  if (!sessionId) return null;
  let domain: string;
  let atMs: number | undefined;
  if (packet.gameId === "f1-2025" || packet.gameId === "iracing") {
    domain = `${packet.gameId === "f1-2025" ? "f1-2025" : "iracing"}-session:${sessionId}`;
    atMs = packet.CurrentRaceTime * 1000;
  } else if (packet.gameId === "ac-evo") {
    domain = "ac-evo-capture-utc-ms";
    atMs = packet.acc?.acEvo?.sourceCaptureUtcMs ?? explicitFrameTimeMs ?? packet.extendedRaceIQ?.frameTimeMs;
  } else if (packet.gameId === "lmu") {
    domain = `lmu-session:${sessionId}`;
    // Actual SDK telemetry session time; never reinterpret wrapper UTC as SDK elapsed time.
    const elapsedTime = packet.lmu?.elapsedTime;
    atMs = elapsedTime === null || elapsedTime === undefined ? undefined : elapsedTime * 1000;
  } else {
    domain = `${packet.gameId}-capture-epoch-ms`;
    atMs = explicitFrameTimeMs ?? packet.extendedRaceIQ?.frameTimeMs;
  }
  if (atMs === undefined || !Number.isFinite(atMs) || atMs < 0) return null;
  return { domain, atMs, sessionId, source: actor?.source ?? `${packet.gameId}-native-unavailable` };
}

interface Observation {
  clock: NativeSourceClock;
  actor: NativeDriverActor | null;
  attribution: DriverAttributionStint["attribution"];
  bindingRevision: number | null;
  bindingSnapshot?: CapturedDriverBinding;
  gameId: TelemetryPacket["gameId"];
  sequence: number;
  maxAgeMs: number;
}
const observations = new WeakMap<TelemetryPacket, Observation>();
const MAX_EVIDENCE_AGE_MS = 2_000;
/** Official F1 25 PARTICIPANTS cadence is five seconds; allow one second of jitter. */
export const F1_PARTICIPANT_EVIDENCE_MAX_AGE_MS = 6_000;
export function nativeDriverEvidenceMaxAgeMs(gameId: GameId): number {
  return gameId === "ac-evo" ? 500
    : gameId === "f1-2025" ? F1_PARTICIPANT_EVIDENCE_MAX_AGE_MS : MAX_EVIDENCE_AGE_MS;
}
const MAX_SOURCE_GAP_MS = 2_000;
function interval(previous: Observation, next: Observation): DriverAttributionStint | null {
  if (previous.clock.domain !== next.clock.domain || previous.clock.sessionId !== next.clock.sessionId ||
    next.clock.atMs <= previous.clock.atMs) return null;
  const contiguous = next.sequence === previous.sequence + 1 && next.clock.atMs - previous.clock.atMs <= MAX_SOURCE_GAP_MS;
  const fresh = previous.actor !== null && previous.actor.observedAtMs + previous.maxAgeMs >= next.clock.atMs &&
    (previous.actor.evidenceExpiresAtMs === undefined || previous.actor.evidenceExpiresAtMs >= next.clock.atMs);
  return { gameId: previous.gameId, source: previous.clock.source, sessionId: previous.clock.sessionId,
    clockDomain: previous.clock.domain, startMs: previous.clock.atMs, endMs: next.clock.atMs,
    evidenceValidUntilMs: next.clock.atMs, actor: previous.actor,
    attribution: contiguous && fresh ? previous.attribution : "Unknown", bindingRevision: previous.bindingRevision,
    ...(previous.bindingSnapshot ? { bindingSnapshot: previous.bindingSnapshot } : {}) };
}
function appendInterval(stints: DriverAttributionStint[], stint: DriverAttributionStint): void {
  const previous = stints.at(-1);
  if (previous && previous.endMs === stint.startMs && previous.clockDomain === stint.clockDomain &&
    previous.sessionId === stint.sessionId && previous.source === stint.source &&
    previous.attribution === stint.attribution && previous.bindingRevision === stint.bindingRevision &&
    previous.bindingSnapshot?.id === stint.bindingSnapshot?.id && previous.bindingSnapshot?.nativeIdentity === stint.bindingSnapshot?.nativeIdentity &&
    previous.actor?.actorId === stint.actor?.actorId) {
    previous.endMs = stint.endMs;
    previous.evidenceValidUntilMs = stint.evidenceValidUntilMs;
  } else stints.push(stint);
}
/** Source actor timestamps locate observed swaps; a missing/older boundary is not guessed. */
function appendObservedIntervals(stints: DriverAttributionStint[], previous: Observation, next: Observation): boolean {
  const stint = interval(previous, next);
  if (!stint) return false;
  if (previous.actor && next.actor && previous.actor.actorId !== next.actor.actorId) {
    const boundary = next.actor.observedAtMs;
    if (next.attribution === "Unknown" || boundary < previous.clock.atMs || boundary > next.clock.atMs ||
      next.sequence !== previous.sequence + 1 || next.clock.atMs - previous.clock.atMs > MAX_SOURCE_GAP_MS) {
      stint.attribution = "Unknown";
    } else {
      if (boundary > previous.clock.atMs) {
        const before = interval(previous, { ...next, clock: { ...next.clock, atMs: boundary } });
        if (before) appendInterval(stints, before);
      }
      if (boundary < next.clock.atMs) {
        const after = interval({ ...next, clock: { ...next.clock, atMs: boundary }, sequence: next.sequence - 1 }, next);
        if (after) appendInterval(stints, after);
      }
      return true;
    }
  }
  appendInterval(stints, stint);
  return true;
}

/** One tracker per detector lifetime; a reset never reuses earlier clock coverage. */
export class NativeAttributionTracker {
  private previous: Observation | null = null;
  private sequence = 0;
  private reset = false;
  private sourceKey: string | null = null;
  readonly stints: DriverAttributionStint[] = [];
  sourceComplete = true;
  invalidate(): void {
    this.previous = null;
    this.sequence++;
    this.sourceComplete = false;
  }
  observe(packet: TelemetryPacket, bindings: readonly DriverActorBinding[], explicitFrameTimeMs?: number): void {
    const clock = getNativeSourceClock(packet, explicitFrameTimeMs);
    const sequence = ++this.sequence;
    if (!clock) { this.sourceComplete = false; this.previous = null; return; }
    // Missing actor evidence must not invent a new source session. Keep only
    // the already-observed source context; attribution itself remains Unknown.
    if (!packet.driverActor && !packet.sessionUID && this.previous?.gameId === packet.gameId &&
      this.previous.clock.domain === clock.domain) {
      clock.sessionId = this.previous.clock.sessionId;
      clock.source = this.previous.clock.source;
    }
    if (this.previous && this.previous.clock.sessionId === clock.sessionId && this.previous.clock.domain === clock.domain &&
      clock.atMs < this.previous.clock.atMs) { this.reset = true; this.sourceComplete = false; }
    const sourceKey = `${clock.domain}\\0${clock.sessionId}`;
    if (this.sourceKey !== null && this.sourceKey !== sourceKey) this.reset = false;
    this.sourceKey = sourceKey;
    if (this.previous && this.previous.clock.sessionId === clock.sessionId && this.previous.clock.domain === clock.domain &&
      clock.atMs - this.previous.clock.atMs > MAX_SOURCE_GAP_MS) this.sourceComplete = false;
    const actor = !this.reset && packet.IsRaceOn === 1 ? packet.driverActor ?? null : null;
    const maxAgeMs = nativeDriverEvidenceMaxAgeMs(packet.gameId);
    const resolved = resolveDriverAttribution({ gameId: packet.gameId, source: clock.source, sessionId: clock.sessionId,
      clockDomain: clock.domain, observedAtMs: clock.atMs, actor, bindings, maxAgeMs });
    const observation: Observation = { clock, actor, ...resolved, gameId: packet.gameId, sequence, maxAgeMs };
    observations.set(packet, observation);
    if (this.previous) {
      appendObservedIntervals(this.stints, this.previous, observation);
    }
    this.previous = observation;
  }
}

/** Capture before asynchronous writes; later rebinding cannot rewrite captured evidence. */
export function captureLapDriverAttribution(packets: readonly TelemetryPacket[], boundary?: TelemetryPacket, wholeStartObserved = true): {
  stints: DriverAttributionStint[];
  attribution: LapDriverAttribution;
  source: { domain: string; startMs: number; endMs: number };
} | null {
  const first = packets[0] && observations.get(packets[0]);
  const last = (boundary ?? packets.at(-1)) && observations.get((boundary ?? packets.at(-1))!);
  if (!first || !last || first.clock.domain !== last.clock.domain || first.clock.sessionId !== last.clock.sessionId ||
    last.clock.atMs <= first.clock.atMs) return null;
  if (!wholeStartObserved) return {
    attribution: "Unknown", source: { domain: first.clock.domain, startMs: first.clock.atMs, endMs: last.clock.atMs },
    stints: [{ gameId: first.gameId, source: first.clock.source, sessionId: first.clock.sessionId,
      clockDomain: first.clock.domain, startMs: first.clock.atMs, endMs: last.clock.atMs,
      evidenceValidUntilMs: last.clock.atMs, actor: null, attribution: "Unknown", bindingRevision: first.bindingRevision,
      ...(first.bindingSnapshot ? { bindingSnapshot: first.bindingSnapshot } : {}) }],
  };
  const stints: DriverAttributionStint[] = [];
  let previous = first;
  for (let index = 1; index <= packets.length; index++) {
    const packet = index === packets.length ? boundary : packets[index];
    if (!packet) continue;
    const next = observations.get(packet);
    if (!next) return { stints: [], attribution: "Unknown", source: { domain: first.clock.domain, startMs: first.clock.atMs, endMs: last.clock.atMs } };
    if (!appendObservedIntervals(stints, previous, next) && next.clock.atMs !== previous.clock.atMs) {
      return { stints: [], attribution: "Unknown", source: { domain: first.clock.domain, startMs: first.clock.atMs, endMs: last.clock.atMs } };
    }
    previous = next;
  }
  const source = { domain: first.clock.domain, startMs: first.clock.atMs, endMs: last.clock.atMs };
  return { stints, attribution: classifyLapAttribution(stints, source.startMs, source.endMs, source.domain), source };
}

export interface NativeBindingCandidateEvidence extends GameIdentityCandidate {
  nativeIdentity: string;
  bindingRevision: number;
  /** Main-host control generation, never an original recording source revision. */
  sourceRevision: number;
}

interface CandidateObservation {
  actor: NativeDriverActor;
  clock: NativeSourceClock;
  nativeIdentity: string;
  carId: TelemetryPacket["carId"];
  trackId: TelemetryPacket["trackId"];
  sessionUID: TelemetryPacket["sessionUID"];
  sessionType: NonNullable<TelemetryPacket["f1"]>["sessionType"] | undefined;
  progressAtMs: number;
  resetPending: boolean;
  f1SessionUID: bigint | null;
}

/** Main-host live native observations only. Host receipt expiry is not a native source clock. */
export class NativeBindingCandidateCache {
  readonly sourceRevisionBuffer = new SharedArrayBuffer(Uint32Array.BYTES_PER_ELEMENT);
  private readonly revision = new Uint32Array(this.sourceRevisionBuffer);
  private readonly listeners = new Set<(sourceRevision: number) => void>();
  private readonly notBeforeReceipts = new Map<GameId, number>();
  private observation: CandidateObservation | null = null;
  private candidate: { id: string; issuedAtMs: number } | null = null;
  private bindingRevision = -1;
  private confirmedBindings: DriverActorBinding[] = [];
  private consumed = false;

  private readonly controlNow: () => number;
  constructor(controlNow: () => number = Date.now) {
    this.controlNow = controlNow;
  }

  private changed(): void {
    const generation = (Atomics.add(this.revision, 0, 1) + 1) >>> 0;
    for (const listener of this.listeners) {
      try { listener(generation); }
      catch (error) { console.warn("[NativeBindingCandidate] Control notification failed", error); }
    }
  }

  subscribeChanges(listener: (sourceRevision: number) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  invalidate(gameId?: GameId, receivedAtMs?: number): void {
    if (gameId && receivedAtMs !== undefined && Number.isFinite(receivedAtMs)) {
      this.notBeforeReceipts.set(gameId, Math.max(receivedAtMs, this.notBeforeReceipts.get(gameId) ?? -Infinity));
    }
    if (gameId && this.observation && this.observation.actor.gameId !== gameId) return;
    this.observation = null;
    this.candidate = null;
    this.consumed = false;
    this.changed();
  }

  updateBindings(snapshot: { revision: number; bindings: readonly GameIdentityBinding[] }): void {
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
      this.bindingRevision = -1;
      this.confirmedBindings = [];
      this.invalidate();
      return;
    }
    if (snapshot.revision === this.bindingRevision) return;
    this.bindingRevision = snapshot.revision;
    this.confirmedBindings = nativeDriverBindings(snapshot.bindings.filter((binding) => binding.confirmation === "user_confirmed"));
    this.candidate = null;
    this.consumed = false;
    this.changed();
  }

  private acceptsReceipt(gameId: GameId, receivedAtMs: number, now: number): boolean {
    return Number.isFinite(receivedAtMs) && receivedAtMs <= now &&
      receivedAtMs > (this.notBeforeReceipts.get(gameId) ?? -Infinity) &&
      now - receivedAtMs < (gameId === "ac-evo" ? 500 : 2_000);
  }

  /** Native source/session loss may precede a complete normalized telemetry snapshot. */
  observeRawSource(gameId: GameId, frame: Buffer, receivedAtMs?: number): void {
    const now = this.controlNow();
    if (!this.acceptsReceipt(gameId, receivedAtMs ?? now, now)) return;
    const current = this.observation;
    if (!current) return;
    if (current.actor.gameId !== gameId) { this.invalidate(); return; }
    if (gameId !== "f1-2025") return;
    if (frame.length < F1_HEADER_SIZE || frame.readUInt16LE(0) !== 2025 ||
      frame.readBigUInt64LE(7) !== current.f1SessionUID) { this.invalidate(); return; }
    const kind = frame.readUInt8(6);
    if ((kind === F1_PACKET_IDS.SESSION || kind === F1_PACKET_IDS.PARTICIPANTS) &&
      (frame.readUInt8(2) !== 25 || frame.readUInt8(5) !== 1)) { this.invalidate(); return; }
    if (kind === F1_PACKET_IDS.SESSION && (frame.length < F1_HEADER_SIZE + 16 ||
      frame.readUInt8(F1_HEADER_SIZE + 14) !== 0 || frame.readUInt8(F1_HEADER_SIZE + 15) !== 0)) this.invalidate();
  }

  /** Called synchronously at parsed ingress, before queue barriers or binding DB awaits. */
  observeSource(packet: TelemetryPacket, clock: NativeSourceClock | null, receivedAtMs?: number): void {
    const now = this.controlNow();
    receivedAtMs ??= now;
    if (!this.acceptsReceipt(packet.gameId, receivedAtMs, now)) return;
    const actor = packet.driverActor;
    if (!actor || !clock || !Number.isFinite(clock.atMs) || clock.atMs < 0 ||
      packet.IsRaceOn !== 1 || actor.gameId !== packet.gameId ||
      actor.source !== clock.source || actor.sessionId !== clock.sessionId || actor.clockDomain !== clock.domain ||
      !Number.isFinite(actor.observedAtMs) || actor.observedAtMs > clock.atMs ||
      clock.atMs - actor.observedAtMs > nativeDriverEvidenceMaxAgeMs(actor.gameId) ||
      (actor.evidenceExpiresAtMs !== undefined &&
        (!Number.isFinite(actor.evidenceExpiresAtMs) || clock.atMs > actor.evidenceExpiresAtMs)) ||
      actor.actorId.length > 128 || actor.sessionId.length > 512 || actor.clockDomain.length > 512) {
      if (this.observation) this.invalidate();
      return;
    }
    const previous = this.observation;
    const same = previous && previous.actor.gameId === actor.gameId && previous.actor.source === actor.source &&
      previous.actor.actorId === actor.actorId && previous.actor.bindingScope === actor.bindingScope &&
      previous.actor.sessionId === actor.sessionId && previous.clock.domain === clock.domain &&
      previous.carId === packet.carId && previous.trackId === packet.trackId &&
      previous.sessionUID === packet.sessionUID && previous.sessionType === packet.f1?.sessionType;
    if (!same) {
      const nativeIdentity = encodeNativeDriverBinding(actor);
      if (!validateNativeDriverBinding({ gameId: actor.gameId, sourceKind: actor.source, nativeIdentity })) {
        if (previous) this.invalidate();
        return;
      }
      this.observation = { actor, clock, nativeIdentity, carId: packet.carId, trackId: packet.trackId,
        sessionUID: packet.sessionUID, sessionType: packet.f1?.sessionType, progressAtMs: receivedAtMs, resetPending: false,
        f1SessionUID: actor.gameId === "f1-2025" ? BigInt(actor.sessionId) : null };
      this.candidate = null;
      this.consumed = false;
      this.changed();
    } else {
      if (clock.atMs < previous.clock.atMs) {
        previous.resetPending = true;
        this.candidate = null;
        this.consumed = false;
        this.changed();
      } else if (clock.atMs > previous.clock.atMs) {
        previous.resetPending = false;
        previous.progressAtMs = receivedAtMs;
      }
      previous.actor = actor;
      previous.clock = clock;
    }
  }

  private current(now: number): { observation: CandidateObservation; expiresAtMs: number } | null {
    const observation = this.observation;
    const receiptAgeMs = observation?.actor.gameId === "ac-evo" ? 500 : 2_000;
    if (!observation || observation.resetPending || this.bindingRevision < 0 || this.consumed ||
      now - observation.progressAtMs < 0 || now - observation.progressAtMs >= receiptAgeMs ||
      this.confirmedBindings.some((binding) => binding.gameId === observation.actor.gameId &&
        binding.source === observation.actor.source && binding.actorId === observation.actor.actorId &&
        (binding.sessionId === undefined || binding.sessionId === observation.actor.sessionId))) {
      if (this.candidate) { this.candidate = null; this.changed(); }
      return null;
    }
    if (this.candidate && (now - this.candidate.issuedAtMs < 0 || now - this.candidate.issuedAtMs >= 15_000)) {
      this.candidate = null;
      this.changed();
    }
    if (!this.candidate) {
      this.candidate = { id: randomUUID(), issuedAtMs: now };
      this.changed();
    }
    return { observation, expiresAtMs: Math.min(this.candidate.issuedAtMs + 15_000, observation.progressAtMs + receiptAgeMs) };
  }

  listCandidates(): { sourceRevision: number; candidates: GameIdentityCandidate[] } {
    const current = this.current(this.controlNow());
    const candidates: GameIdentityCandidate[] = current ? [{ candidateId: this.candidate!.id,
      gameId: current.observation.actor.gameId, sourceKind: current.observation.actor.source,
      expiresAt: new Date(current.expiresAtMs).toISOString() }] : [];
    return { sourceRevision: Atomics.load(this.revision, 0), candidates };
  }

  resolveCandidate(candidateId: string, expectedBindingRevision: number): NativeBindingCandidateEvidence | null {
    const current = this.current(this.controlNow());
    if (!current || candidateId !== this.candidate?.id || expectedBindingRevision !== this.bindingRevision) return null;
    return { candidateId, gameId: current.observation.actor.gameId, sourceKind: current.observation.actor.source,
      nativeIdentity: current.observation.nativeIdentity, expiresAt: new Date(current.expiresAtMs).toISOString(),
      bindingRevision: this.bindingRevision, sourceRevision: Atomics.load(this.revision, 0) };
  }

  consumeCandidate(candidateId: string, sourceRevision: number): void {
    if (this.candidate?.id !== candidateId || Atomics.load(this.revision, 0) !== sourceRevision) return;
    this.candidate = null;
    this.consumed = true;
    this.changed();
  }
}
