import { createHash } from "node:crypto";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { compileTelemetryResolver } from "../../shared/telemetry/resolver/compile";
import type { CompiledTelemetryResolver, ResolvedValue, TelemetryFrameView } from "../../shared/telemetry/resolver/contracts";
import { liveSemanticIds } from "../../shared/telemetry/live/semantics";
import type { LiveTelemetryFrameMessageV1, LiveTelemetrySchemaMessageV1 } from "../../shared/telemetry/live/contracts";
import type { LivePitData, LiveSectorData } from "../../shared/racing/live/types";
import type { TuneIssue } from "../../shared/racing/tuning/issues";
import { encodeLiveFrame, encodeLiveSchema } from "./live-wire";
export interface LiveProjectionInput { packet: TelemetryPacket; sessionId?: number | null; sectors?: LiveSectorData | null; pit?: LivePitData | null; liveIssues?: readonly TuneIssue[]; receivedAtMs: number; }
export interface LiveProjection { schema?: LiveTelemetrySchemaMessageV1; frame?: LiveTelemetryFrameMessageV1; }
const hash = (parts: readonly string[]) => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);

export class LiveTelemetryProjector {
  private resolver: CompiledTelemetryResolver<TelemetryPacket> | null = null;
  private view: TelemetryFrameView<TelemetryPacket> | undefined;
  private gameId: GameId | null = null;
  private sessionId: number | null = null;
  private streamId = "";
  private sequence = -1;
  private schema: LiveTelemetrySchemaMessageV1 | undefined;

  project(input: LiveProjectionInput): LiveProjection {
    const gameId = input.packet.gameId as GameId;
    const sessionId = input.sessionId ?? null;
    if (this.gameId !== gameId || this.sessionId !== sessionId || !this.resolver) this.startStream(gameId, sessionId);
    const resolver = this.resolver!;
    const observedMs = Number.isFinite(input.packet.TimestampMS) ? input.packet.TimestampMS : input.receivedAtMs;
    const timestampDomain = gameId === "acc" || gameId === "ac-evo" ? "wall-clock" as const : "session" as const;
    const observation = { timestamp: { domain: timestampDomain, milliseconds: observedMs }, updateSequence: BigInt(this.sequence + 1) };
    this.view = resolver.createFrameView(input.packet, observation, this.view);
    const resolved = this.view.resolveMany(liveSemanticIds(gameId).map((id) => resolver.slot(id))) as readonly ResolvedValue<unknown>[];
    const states: Record<number, "missing" | "stale" | "invalid" | "not-applicable" | "error"> = {};
    const freshness: Record<number, "stale" | "unknown"> = {};
    resolved.forEach((value, index) => {
      if (value.state !== "ok") states[index] = value.state;
      if (value.freshness !== "fresh") freshness[index] = value.freshness;
    });
    if (this.sequence < 0) {
      const ids = liveSemanticIds(gameId);
      const { definitions: _oldDefinitions, ...schemaMeta } = this.schema!;
      this.schema = encodeLiveSchema(resolved.map((value, index) => ({ semanticId: ids[index], unit: value.unit, mappingStatus: value.mappingStatus, schemaVersion: value.schemaVersion, limitations: Array.isArray(value.limitations) ? value.limitations.filter((limitation): limitation is string => typeof limitation === "string") : typeof value.limitations === "string" ? [value.limitations] : [] })), schemaMeta);
    }
    const frame = encodeLiveFrame({ schemaId: this.schema!.schemaId, streamId: this.streamId, sessionId: this.sessionId, sequence: this.sequence + 1, observedAt: { domain: timestampDomain, milliseconds: observedMs }, receivedAtMs: input.receivedAtMs, values: resolved, ...(Object.keys(states).length ? { states } : {}), ...(Object.keys(freshness).length ? { freshness } : {}), context: { ...(input.sectors ? { sectors: input.sectors } : {}), ...(input.pit ? { pit: input.pit } : {}), ...(input.liveIssues ? { liveIssues: input.liveIssues } : {}) } });
    this.sequence += 1;
    return this.sequence === 0 ? { schema: this.schema, frame } : { frame };
  }

  reset(): void { this.resolver = null; this.view = undefined; this.gameId = null; this.sessionId = null; this.schema = undefined; this.sequence = -1; this.streamId = ""; }

  private startStream(gameId: GameId, sessionId: number | null): void {
    this.gameId = gameId; this.sessionId = sessionId; this.sequence = -1; this.view = undefined;
    this.resolver = compileTelemetryResolver({ simulator: gameId, requested: liveSemanticIds(gameId).map((semanticId) => ({ semanticId })) });
    const ids = liveSemanticIds(gameId);
    const schemaId = hash(["live", "1", gameId, this.resolver.catalogVersion, this.resolver.catalogHash, this.resolver.schemaVersion, this.resolver.parserVersion, this.resolver.resolverVersion, this.resolver.derivationVersion, ...ids]);
    this.schema = encodeLiveSchema(ids.map((semanticId) => ({ semanticId, unit: null, mappingStatus: "unavailable", schemaVersion: this.resolver!.schemaVersion, limitations: [] })), { schemaId, simulator: gameId, catalogVersion: this.resolver.catalogVersion, catalogHash: this.resolver.catalogHash, catalogSchemaVersion: this.resolver.schemaVersion, parserVersion: this.resolver.parserVersion, resolverVersion: this.resolver.resolverVersion, derivationVersion: this.resolver.derivationVersion });
    this.streamId = hash(["stream", gameId, sessionId === null ? "none" : String(sessionId), schemaId]);
  }
}
