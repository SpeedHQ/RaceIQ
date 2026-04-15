import type { TelemetryPacket } from "@shared/types";

interface Props {
  packet: TelemetryPacket | null;
}

function flatten(obj: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (obj === null || obj === undefined) {
    if (prefix) out[prefix] = obj;
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, prefix ? `${prefix}[${i}]` : `[${i}]`, out));
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
    return (
      <div className="p-4 text-app-text-dim">
        Waiting for telemetry data...
      </div>
    );
  }

  const entries = Object.entries(flatten(packet)).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="p-4 overflow-auto h-full">
      <div className="text-xs text-app-text-muted uppercase tracking-wider mb-3">
        All Telemetry Values ({entries.length} fields)
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-0.5">
        {entries.map(([key, value]) => (
          <div
            key={key}
            className="flex justify-between items-center py-0.5 border-b border-app-border/50"
          >
            <span className="text-xs text-app-text-secondary truncate mr-2">{key}</span>
            <span className="text-xs font-mono text-app-text tabular-nums shrink-0">
              {typeof value === "number"
                ? Number.isInteger(value)
                  ? value
                  : value.toFixed(3)
                : String(value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
