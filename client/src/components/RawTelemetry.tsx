import type { TelemetryGameLink, TelemetryVariableDefinition } from "@shared/telemetry/catalog/contracts";
import { TELEMETRY_CATALOG } from "@shared/telemetry/catalog/data";
import { m } from "@/paraglide/messages";
import type { TelemetryPacket } from "../../../shared/telemetry/types";

interface Props {
  packet: TelemetryPacket | null;
}

export type RawTelemetryCategory = "dynamic" | "static" | "event" | "unsupported";

interface RawTelemetryMetadata {
  readonly variable: TelemetryVariableDefinition;
  readonly link: TelemetryGameLink;
  readonly category: RawTelemetryCategory;
}

const variablesByPacketField = new Map<string, TelemetryVariableDefinition[]>();
for (const variable of TELEMETRY_CATALOG.variables) {
  for (const packetField of variable.packetFields ?? []) {
    const matches = variablesByPacketField.get(packetField) ?? [];
    matches.push(variable);
    variablesByPacketField.set(packetField, matches);
  }
}

function categoryForLink(link: Exclude<TelemetryGameLink, { kind: "unavailable" }>): RawTelemetryCategory {
  switch (link.freshness) {
    case "continuous":
      return "dynamic";
    case "static":
      return "static";
    case "session-update":
    case "pit-snapshot":
      return "event";
  }
}

function metadataForField(field: string, gameId: TelemetryPacket["gameId"]): RawTelemetryMetadata | null {
  const variable = variablesByPacketField.get(field)?.[0];
  if (!variable || !gameId || !(gameId in variable.games)) return null;
  const link = variable.games[gameId];
  return link.kind === "unavailable" ? { variable, link, category: "unsupported" } : { variable, link, category: categoryForLink(link) };
}

function flatten(obj: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (obj === null || obj === undefined) {
    if (prefix) out[prefix] = obj;
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => {
      flatten(v, prefix ? `${prefix}[${i}]` : `[${i}]`, out);
    });
    return out;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
  }
  out[prefix] = obj;
  return out;
}

export function RawTelemetry({ packet }: Props) {
  if (!packet) {
    return <div className="p-4 text-app-text-dim">{m.rawtel_waiting()}</div>;
  }

  const flattened = flatten(packet);
  const unsupportedFields = [
    ...new Set(
      TELEMETRY_CATALOG.variables
        .filter((variable) => variable.games[packet.gameId].kind === "unavailable")
        .flatMap((variable) => variable.packetFields ?? [])
        .filter((field) => !(field in flattened)),
    ),
  ];
  const entries = [...Object.entries(flattened), ...unsupportedFields.map((field) => [field, undefined] as const)].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="p-4 overflow-auto h-full">
      <div className="text-xs text-app-text-muted uppercase tracking-wider mb-3">
        {m.rawtel_title()} ({entries.length} fields)
      </div>
      <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 @3xl/workspace:grid-cols-2 @5xl/workspace:grid-cols-3">
        {entries.map(([key, value]) => {
          const metadata = metadataForField(key, packet.gameId);
          const unsupported = metadata?.category === "unsupported";
          const displayValue = unsupported ? "Unavailable" : typeof value === "number" ? (Number.isInteger(value) ? String(value) : value.toFixed(3)) : String(value);
          const provenance = metadata
            ? metadata.link.kind === "unavailable"
              ? `unavailable:${metadata.link.reason}`
              : `${metadata.link.provenance.origin}:${metadata.link.provenance.artifact}@${TELEMETRY_CATALOG.metadata.sourceHashes[metadata.link.provenance.artifact]}`
            : undefined;
          return (
            <div
              key={key}
              className="flex min-w-0 justify-between items-center py-0.5 border-b border-app-border/50"
              data-telemetry-field={metadata ? key : undefined}
              data-telemetry-category={metadata?.category}
              data-telemetry-unit={metadata?.variable.canonicalUnit}
              data-telemetry-provenance={metadata ? provenance : undefined}
              data-telemetry-source={metadata?.link.kind === "unavailable" ? undefined : metadata?.link.sources ? JSON.stringify(metadata.link.sources) : undefined}
            >
              <span className="min-w-0 text-xs text-app-text-secondary truncate mr-2">
                {key}
                {metadata && (
                  <span className="ml-1 text-app-text-muted">
                    [{metadata.variable.canonicalUnit} · {metadata.category}]
                  </span>
                )}
              </span>
              <span className={`text-xs font-mono tabular-nums shrink-0 ${unsupported ? "text-status-warning" : "text-app-text"}`} title={metadata ? provenance : undefined}>
                {displayValue}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
