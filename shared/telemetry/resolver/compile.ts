import type { GameId } from "../../games/ids";
import type { TelemetryCatalogData } from "../catalog/contracts";
import { TELEMETRY_CATALOG } from "../catalog/data";
import { getBuiltinTelemetryDerivation, TELEMETRY_DERIVATION_VERSION } from "../derivations/builtins";
import type { TelemetryDerivation } from "../derivations/contracts";
import type { TelemetryPacket } from "../types";
import type { CompiledTelemetryResolver, ResolverCompileOptions, SemanticSlot, TelemetryFrameView } from "./contracts";
import { FrameView } from "./frame-view";
import type { Mapping, ResolutionPlan, RuntimeCatalogMetadata } from "./plan";
import { readerFor, trustedNativeExecutor } from "./readers";
import { TELEMETRY_PARSER_VERSIONS, TELEMETRY_RESOLVER_VERSION } from "./versions";

type RuntimeCatalog = TelemetryCatalogData & { metadata?: RuntimeCatalogMetadata };

const DEFAULT_STALE_MS = {
  continuous: 1_000,
  "pit-snapshot": 30_000,
  "session-update": 300_000,
  static: Number.POSITIVE_INFINITY,
} as const;

class Resolver<NativeFrame> implements CompiledTelemetryResolver<NativeFrame> {
  readonly plans: readonly ResolutionPlan[]; readonly catalogVersion: string; readonly catalogHash: string; readonly schemaVersion: string; readonly simulator: GameId; readonly parserId: string; readonly parserVersion: string; readonly resolverVersion = TELEMETRY_RESOLVER_VERSION; readonly derivationVersion = TELEMETRY_DERIVATION_VERSION; private readonly slots = new Map<string, SemanticSlot>();
  constructor(catalog: TelemetryCatalogData, options: ResolverCompileOptions) {
    const metadata = (catalog as RuntimeCatalog).metadata; this.catalogVersion = metadata?.catalogVersion ?? catalog.format; this.catalogHash = metadata?.contentHash ?? "unversioned-catalog"; this.schemaVersion = metadata?.schemaVersion ?? catalog.format; this.simulator = options.simulator; this.parserId = options.parserId ?? options.simulator; this.parserVersion = options.parserVersion ?? TELEMETRY_PARSER_VERSIONS[options.simulator];
    const variables = new Map(catalog.variables.map((variable) => [variable.id, variable])); const custom = new Map((options.derivations ?? []).map((definition) => [definition.output.semanticId, definition])); const visiting = new Set<string>(); const ordered = new Set<string>();
    const derivationFor = (
      id: string,
      mapping: Mapping,
    ): TelemetryDerivation | undefined =>
      mapping.kind === "derived"
        ? custom.get(id) ?? getBuiltinTelemetryDerivation(id)
        : undefined;
    const visit = (id: string): void => {
      if (ordered.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`Telemetry derivation cycle at ${id}`);
      }
      visiting.add(id);
      const variable = variables.get(id);
      if (!variable) throw new Error(`Unknown telemetry semantic ${id}`);
      const mapping = variable.games[options.simulator];
      if (!mapping) throw new Error(`${id} missing ${options.simulator} mapping`);
      const derivation = derivationFor(id, mapping);
      if (derivation) {
        for (const input of derivation.inputs) visit(input.semanticId);
      }
      visiting.delete(id);
      ordered.add(id);
    };
    for (const request of options.requested) visit(request.semanticId);
    this.plans = [...ordered].map((id, index) => {
      const variable = variables.get(id)!;
      const mapping = variable.games[options.simulator];
      if (mapping.kind === "simplified" && options.rejectSimplified) {
        throw new Error(`Simplified telemetry mapping rejected for ${id}`);
      }
      const derivation = derivationFor(id, mapping);
      const nativeExecutor =
        mapping.kind === "unavailable"
          ? undefined
          : trustedNativeExecutor(variable, mapping);
      const unsupportedExecution =
        mapping.kind === "normalized" &&
        mapping.execution?.kind !== "conversion";
      const unavailableExecutor =
        (mapping.kind === "normalized" ||
          mapping.kind === "derived" ||
          mapping.kind === "simplified") &&
        !variable.packetFields?.length &&
        derivation === undefined &&
        nativeExecutor === undefined;
      const executorError =
        unsupportedExecution || unavailableExecutor
          ? `unsupported-${mapping.kind}-executor:${options.simulator}:${id}`
          : undefined;
      const reader =
        mapping.kind === "unavailable" ||
        executorError !== undefined ||
        derivation !== undefined
          ? undefined
          : nativeExecutor ?? readerFor(variable, mapping);
      if (
        options.requested.some(
          (request) => request.semanticId === id && request.required,
        ) &&
        mapping.kind === "unavailable" &&
        !derivation
      ) {
        throw new Error(
          `Required telemetry semantic unavailable: ${id} for ${options.simulator}`,
        );
      }
      this.slots.set(id, index as SemanticSlot);
      return {
        semanticId: id,
        variable,
        mapping,
        reader,
        derivation,
        executorError,
        staleAfterMs:
          options.staleAfterMs?.[id] ??
          (mapping.kind === "unavailable"
            ? Number.POSITIVE_INFINITY
            : DEFAULT_STALE_MS[mapping.freshness]),
      };
    });
  }
  slot(id: string): SemanticSlot { const slot = this.slots.get(id); if (slot === undefined) throw new Error(`Telemetry semantic not compiled: ${id}`); return slot; }
  createFrameView(native: NativeFrame, timestamp: number, reuse?: TelemetryFrameView<NativeFrame>): TelemetryFrameView<NativeFrame> { const view = reuse instanceof FrameView && reuse.resolver === this ? reuse : new FrameView(this, this.plans.length); return view.reset(native, timestamp); }
}

export function compileTelemetryResolver<NativeFrame = TelemetryPacket>(
  options: ResolverCompileOptions,
): CompiledTelemetryResolver<NativeFrame>;
export function compileTelemetryResolver<NativeFrame = TelemetryPacket>(
  catalog: TelemetryCatalogData,
  options: ResolverCompileOptions,
): CompiledTelemetryResolver<NativeFrame>;
export function compileTelemetryResolver<NativeFrame = TelemetryPacket>(
  catalogOrOptions: TelemetryCatalogData | ResolverCompileOptions,
  maybeOptions?: ResolverCompileOptions,
): CompiledTelemetryResolver<NativeFrame> {
  const catalog = maybeOptions ? (catalogOrOptions as TelemetryCatalogData) : TELEMETRY_CATALOG;
  const options = maybeOptions ?? (catalogOrOptions as ResolverCompileOptions);
  return new Resolver<NativeFrame>(catalog, options);
}
