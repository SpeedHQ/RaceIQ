import { createHash } from "node:crypto";
import type { GameId } from "../../shared/games/ids";
import type { CanonicalTelemetryScalar, SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import type { TelemetryVariableId } from "../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { compileTelemetryResolver } from "../../shared/telemetry/resolver/compile";
import type { CompiledTelemetryResolver, ResolvedValue, SemanticSlot, TelemetryFrameView } from "../../shared/telemetry/resolver/contracts";
import { liveSemanticIds } from "../../shared/telemetry/live/semantics";
import type { LiveTelemetryFrameMessageV1, LiveTelemetrySchemaMessageV1 } from "../../shared/telemetry/live/contracts";
import type { LivePitData, LiveSectorData } from "../../shared/racing/live/types";
import type { TuneIssue } from "../../shared/racing/tuning/issues";
import { getServerGame } from "../games/registry";
import { encodeLiveFrame, encodeLiveSchema } from "./live-wire";

export interface LiveProjectionInput {
  packet: TelemetryPacket;
  sessionId?: number | null;
  sectors?: LiveSectorData | null;
  pit?: LivePitData | null;
  liveIssues?: readonly TuneIssue[];
  receivedAtMs: number;
}

export interface LiveProjection {
  schema?: LiveTelemetrySchemaMessageV1;
  frame?: LiveTelemetryFrameMessageV1;
  sample: SemanticTelemetrySample;
}

export interface ResolvedLiveTelemetry {
  readonly sample: SemanticTelemetrySample;
  readonly resolved: readonly ResolvedValue<unknown>[];
  readonly gameId: GameId;
  readonly receivedAtMs: number;
}

const hash = (parts: readonly string[]) => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);

function consumerSafeValue(value: unknown): CanonicalTelemetryScalar | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (!Array.isArray(value)) return undefined;
  const safeValues: CanonicalTelemetryScalar[] = [];
  for (const entry of value) {
    const safeEntry = consumerSafeValue(entry);
    if (safeEntry === undefined) return undefined;
    safeValues.push(safeEntry);
  }
  return safeValues;
}

export class LiveTelemetryProjector {
  private resolver: CompiledTelemetryResolver<TelemetryPacket> | null = null;
  private view: TelemetryFrameView<TelemetryPacket> | undefined;
  private gameId: GameId | null = null;
  private sessionId: number | null = null;
  private streamId = "";
  private sequence = -1;
  private lastObservedAtMs: number | null = null;
  private schema: LiveTelemetrySchemaMessageV1 | undefined;
  private semanticIds: readonly string[] = [];
  private semanticSlots: readonly SemanticSlot[] = [];

  private readonly extraSemanticIds: readonly string[];

  constructor(extraSemanticIds: readonly string[] = []) {
    this.extraSemanticIds = extraSemanticIds;
  }

  resolve(packet: TelemetryPacket, receivedAtMs: number, sessionId: number | null = null, sessionBoundary = false): ResolvedLiveTelemetry {
    const gameId = packet.gameId as GameId;
    if (this.gameId !== gameId || this.resolver === null || sessionBoundary) this.startStream(gameId);
    else if (this.sessionId !== sessionId) this.startSession(sessionId);
    const resolver = this.resolver;
    if (resolver === null) throw new Error("Live telemetry resolver failed to initialize");
    const adapter = getServerGame(gameId);
    const observedMs = adapter.raceEventObservedAtMs(packet, receivedAtMs);
    if (this.lastObservedAtMs !== null && observedMs < this.lastObservedAtMs) {
      this.view?.resetSourceState();
    }
    this.lastObservedAtMs = Number.isFinite(observedMs) ? observedMs : null;
    const observation = {
      timestamp: {
        domain: adapter.raceEventTimestampDomain,
        milliseconds: observedMs,
      },
      updateSequence: BigInt(this.sequence + 1),
    };
    const view = resolver.createFrameView(packet, observation, this.view);
    this.view = view;
    const resolved = view.resolveMany(this.semanticSlots) as readonly ResolvedValue<unknown>[];
    const values: Partial<Record<TelemetryVariableId, CanonicalTelemetryScalar>> = {};
    for (const value of resolved) {
      if (value.state !== "ok" || value.freshness !== "fresh") continue;
      const safeValue = consumerSafeValue(value.value);
      if (safeValue !== undefined) {
        values[value.semanticId as TelemetryVariableId] = safeValue;
      }
    }
    return {
      gameId,
      receivedAtMs,
      resolved,
      sample: {
        sequence: String(this.sequence + 1),
        observedAtMs: observedMs,
        values,
      },
    };
  }

  publish(resolvedTelemetry: ResolvedLiveTelemetry, input: Omit<LiveProjectionInput, "packet" | "receivedAtMs">): LiveProjection {
    const sessionId = input.sessionId ?? null;
    if (this.sessionId !== sessionId) this.startSession(sessionId);
    const states: Record<number, "missing" | "stale" | "invalid" | "not-applicable" | "error"> = {};
    const freshness: Record<number, "stale" | "unknown"> = {};
    resolvedTelemetry.resolved.forEach((value, index) => {
      if (value.state !== "ok") states[index] = value.state;
      if (value.freshness !== "fresh") freshness[index] = value.freshness;
    });
    const schema = this.schema;
    if (!schema) throw new Error("Live telemetry schema failed to initialize");
    if (this.sequence < 0) {
      const { definitions: _oldDefinitions, ...schemaMeta } = schema;
      this.schema = encodeLiveSchema(
        resolvedTelemetry.resolved.map((value, index) => {
          const semanticId = this.semanticIds[index];
          if (semanticId === undefined) throw new Error("Live telemetry resolver returned an unknown slot");
          return {
            semanticId,
            unit: value.unit,
            mappingStatus: value.mappingStatus,
            schemaVersion: value.schemaVersion,
            limitations: Array.isArray(value.limitations)
              ? value.limitations.filter((limitation): limitation is string => typeof limitation === "string")
              : typeof value.limitations === "string"
                ? [value.limitations]
                : [],
          };
        }),
        schemaMeta,
      );
    }
    const currentSchema = this.schema;
    if (!currentSchema) throw new Error("Live telemetry schema failed to initialize");
    const frame = encodeLiveFrame({
      schemaId: currentSchema.schemaId,
      streamId: this.streamId,
      sessionId: this.sessionId,
      sequence: this.sequence + 1,
      observedAt: {
        domain: resolvedTelemetry.gameId === "acc" || resolvedTelemetry.gameId === "ac-evo" ? "wall-clock" : "session",
        milliseconds: resolvedTelemetry.sample.observedAtMs,
      },
      receivedAtMs: resolvedTelemetry.receivedAtMs,
      values: resolvedTelemetry.resolved,
      ...(Object.keys(states).length ? { states } : {}),
      ...(Object.keys(freshness).length ? { freshness } : {}),
      context: {
        ...(input.sectors ? { sectors: input.sectors } : {}),
        ...(input.pit ? { pit: input.pit } : {}),
        ...(input.liveIssues ? { liveIssues: input.liveIssues } : {}),
      },
    });
    this.sequence += 1;
    return {
      ...(this.sequence === 0 ? { schema: this.schema } : {}),
      frame,
      sample: resolvedTelemetry.sample,
    };
  }

  project(input: LiveProjectionInput): LiveProjection {
    return this.publish(this.resolve(input.packet, input.receivedAtMs, input.sessionId ?? null), input);
  }

  reset(): void {
    this.resolver = null;
    this.view = undefined;
    this.gameId = null;
    this.sessionId = null;
    this.schema = undefined;
    this.sequence = -1;
    this.lastObservedAtMs = null;
    this.streamId = "";
    this.semanticIds = [];
    this.semanticSlots = [];
  }

  private startStream(gameId: GameId): void {
    this.gameId = gameId;
    this.sessionId = null;
    this.sequence = -1;
    this.view = undefined;
    this.semanticIds = [...new Set([...liveSemanticIds(gameId), ...this.extraSemanticIds])];
    const resolver = compileTelemetryResolver({
      simulator: gameId,
      requested: this.semanticIds.map((semanticId) => ({ semanticId })),
    });
    this.resolver = resolver;
    this.semanticSlots = this.semanticIds.map((id) => resolver.slot(id));
    const schemaId = hash([
      "live",
      "1",
      gameId,
      resolver.catalogVersion,
      resolver.catalogHash,
      resolver.schemaVersion,
      resolver.parserVersion,
      resolver.resolverVersion,
      resolver.derivationVersion,
      ...this.semanticIds,
    ]);
    this.schema = encodeLiveSchema(
      this.semanticIds.map((semanticId) => ({
        semanticId,
        unit: null,
        mappingStatus: "unavailable",
        schemaVersion: resolver.schemaVersion,
        limitations: [],
      })),
      {
        schemaId,
        simulator: gameId,
        catalogVersion: resolver.catalogVersion,
        catalogHash: resolver.catalogHash,
        catalogSchemaVersion: resolver.schemaVersion,
        parserVersion: resolver.parserVersion,
        resolverVersion: resolver.resolverVersion,
        derivationVersion: resolver.derivationVersion,
      },
    );
    this.startSession(null);
  }

  private startSession(sessionId: number | null): void {
    const gameId = this.gameId;
    const schema = this.schema;
    if (gameId === null || !schema) throw new Error("Live telemetry stream failed to initialize");
    this.sessionId = sessionId;
    this.sequence = -1;
    this.lastObservedAtMs = null;
    this.view = undefined;
    this.streamId = hash(["stream", gameId, sessionId === null ? "none" : String(sessionId), schema.schemaId]);
  }
}
