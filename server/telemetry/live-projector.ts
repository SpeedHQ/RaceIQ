import { createHash } from "node:crypto";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { compileTelemetryResolver } from "../../shared/telemetry/resolver/compile";
import type { CompiledTelemetryResolver, ResolvedValue, TelemetryFrameView, TelemetryTimestamp, SemanticSlot } from "../../shared/telemetry/resolver/contracts";
import { liveEngineerRequiredSemanticIds, liveSemanticIds } from "../../shared/telemetry/live/semantics";
import { CREWCHIEF_CALLOUT_SEMANTIC_IDS } from "../../shared/telemetry/live/crewchief-callout-contract";
import type { LiveTelemetryFrameMessageV1, LiveTelemetrySchemaMessageV1 } from "../../shared/telemetry/live/contracts";
import type { LivePitData, LiveSectorData } from "../../shared/racing/live/types";
import type { TuneIssue } from "../../shared/racing/tuning/issues";
import { encodeLiveFrame, encodeLiveSchema } from "./live-wire";
export interface LiveProjectionInput { packet: TelemetryPacket; sessionId?: number | null; sectors?: LiveSectorData | null; pit?: LivePitData | null; liveIssues?: readonly TuneIssue[]; receivedAtMs: number; }
export interface LiveResolvedSemanticFrame {
  simulator: GameId;
  sessionId: number | null;
  streamId: string;
  sequence: number;
  observedAt: TelemetryTimestamp;
  ids: readonly string[];
  values: readonly ResolvedValue<unknown>[];
}
export interface LiveProjection { schema?: LiveTelemetrySchemaMessageV1; frame?: LiveTelemetryFrameMessageV1; semanticFrame: LiveResolvedSemanticFrame; }
const hash = (parts: readonly string[]) => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);

export class LiveTelemetryProjector {
  private resolver: CompiledTelemetryResolver<TelemetryPacket> | null = null;
  private view: TelemetryFrameView<TelemetryPacket> | undefined;
  private gameId: GameId | null = null;
  private sessionId: number | null = null;
  private streamId = "";
  private sequence = -1;
  private schema: LiveTelemetrySchemaMessageV1 | undefined;
  private publicIds: readonly string[] = [];
  private publicSlots: SemanticSlot[] = [];
  private engineerIds: readonly string[] = [];
  private engineerSlots: SemanticSlot[] = [];
  private publicValues: ResolvedValue<unknown>[] = [];
  private engineerValues: ResolvedValue<unknown>[] = [];

  project(input: LiveProjectionInput): LiveProjection {
    const gameId = input.packet.gameId as GameId;
    const sessionId = input.sessionId ?? null;
    if (this.gameId !== gameId || this.sessionId !== sessionId || !this.resolver) this.startStream(gameId, sessionId);
    const resolver = this.resolver!;
    const observedMs = Number.isFinite(input.packet.TimestampMS) ? input.packet.TimestampMS : input.receivedAtMs;
    const timestampDomain = gameId === "acc" || gameId === "ac-evo" ? "wall-clock" as const : "session" as const;
    const observedAt = { domain: timestampDomain, milliseconds: observedMs } as const;
    const observation = { timestamp: observedAt, updateSequence: BigInt(this.sequence + 1) };
    this.view = resolver.createFrameView(input.packet, observation, this.view);
    const publicResolved = this.view.resolveMany(this.publicSlots, this.publicValues);
    const engineerResolved = this.view.resolveMany(this.engineerSlots, this.engineerValues);
    const states: Record<number, "missing" | "stale" | "invalid" | "not-applicable" | "error"> = {};
    const freshness: Record<number, "stale" | "unknown"> = {};
    publicResolved.forEach((value, index) => {
      if (value.state !== "ok") states[index] = value.state;
      if (value.freshness !== "fresh") freshness[index] = value.freshness;
    });
    if (this.sequence < 0) {
      const { definitions: _oldDefinitions, ...schemaMeta } = this.schema!;
      this.schema = encodeLiveSchema(publicResolved.map((value, index) => ({ semanticId: this.publicIds[index]!, unit: value.unit, mappingStatus: value.mappingStatus, schemaVersion: value.schemaVersion, limitations: Array.isArray(value.limitations) ? value.limitations.filter((limitation): limitation is string => typeof limitation === "string") : typeof value.limitations === "string" ? [value.limitations] : [] })), schemaMeta);
    }
    const sequence = this.sequence + 1;
    this.sequence = sequence;
    const frame = encodeLiveFrame({ schemaId: this.schema!.schemaId, streamId: this.streamId, sessionId: this.sessionId, sequence, observedAt, receivedAtMs: input.receivedAtMs, values: publicResolved, ...(Object.keys(states).length ? { states } : {}), ...(Object.keys(freshness).length ? { freshness } : {}), context: { ...(input.sectors ? { sectors: input.sectors } : {}), ...(input.pit ? { pit: input.pit } : {}), ...(input.liveIssues ? { liveIssues: input.liveIssues } : {}) } });
    return {
      ...(sequence === 0 ? { schema: this.schema } : {}),
      frame,
      semanticFrame: { simulator: gameId, sessionId: this.sessionId, streamId: this.streamId, sequence, observedAt, ids: this.engineerIds, values: engineerResolved },
    };
  }

  reset(): void { this.resolver = null; this.view = undefined; this.gameId = null; this.sessionId = null; this.schema = undefined; this.sequence = -1; this.streamId = ""; this.publicIds = []; this.publicSlots = []; this.engineerIds = []; this.engineerSlots = []; this.publicValues = []; this.engineerValues = []; }

  private startStream(gameId: GameId, sessionId: number | null): void {
    this.gameId = gameId; this.sessionId = sessionId; this.sequence = -1; this.view = undefined;
    this.publicIds = liveSemanticIds(gameId);
    this.engineerIds = liveEngineerRequiredSemanticIds(gameId);
    const compiledIds = [...new Set([...this.publicIds, ...this.engineerIds, ...CREWCHIEF_CALLOUT_SEMANTIC_IDS])];
    this.resolver = compileTelemetryResolver({ simulator: gameId, requested: compiledIds.map((semanticId) => ({ semanticId })) });
    this.publicSlots = this.publicIds.map((semanticId) => this.resolver!.slot(semanticId));
    this.engineerSlots = this.engineerIds.map((semanticId) => this.resolver!.slot(semanticId));
    this.publicValues = new Array(this.publicIds.length);
    this.engineerValues = new Array(this.engineerIds.length);
    const schemaId = hash(["live", "1", gameId, this.resolver.catalogVersion, this.resolver.catalogHash, this.resolver.schemaVersion, this.resolver.parserVersion, this.resolver.resolverVersion, this.resolver.derivationVersion, ...this.publicIds]);
    this.schema = encodeLiveSchema(this.publicIds.map((semanticId) => ({ semanticId, unit: null, mappingStatus: "unavailable", schemaVersion: this.resolver!.schemaVersion, limitations: [] })), { schemaId, simulator: gameId, catalogVersion: this.resolver.catalogVersion, catalogHash: this.resolver.catalogHash, catalogSchemaVersion: this.resolver.schemaVersion, parserVersion: this.resolver.parserVersion, resolverVersion: this.resolver.resolverVersion, derivationVersion: this.resolver.derivationVersion });
    this.streamId = hash(["stream", gameId, sessionId === null ? "none" : String(sessionId), schemaId]);
  }
}
