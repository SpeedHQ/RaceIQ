import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { TELEMETRY_CATALOG } from "../../shared/telemetry/catalog/data";
import { canonicalizeTelemetryScalar } from "../../shared/telemetry/replay/canonicalize";
import { compileTelemetryResolver } from "../../shared/telemetry/resolver/compile";
import type { ResolvedValue, SourceObservation } from "../../shared/telemetry/resolver/contracts";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { wheelSlipRatios } from "../../shared/racing/analysis/laps/physics/vehicle";

export const DEMO_SEMANTIC_IDS = [
  "identity.track-ordinal", "identity.car-ordinal", "motion.position-x", "motion.position-z", "motion.speed", "motion.yaw", "motion.pitch", "motion.roll",
  "inputs.accel", "inputs.brake", "inputs.gear", "inputs.steer", "timing.distance-traveled", "timing.current-lap", "diagnostics.timestamp-ms",
  "suspension.norm-suspension-travel", "tires.tire-slip-ratio", "tires.normalized-tire-slip-angle", "tires.wheel-rotation-speed", "tires.tire-wear", "tire.temperature.average",
] as const;

export interface DemoSemanticFrame {
  values: Record<string, unknown>;
  states: Record<string, string>;
  freshness: Record<string, string>;
}

function parseCsv(path: string): TelemetryPacket[] {
  const rows = readFileSync(path, "utf8").trim().split("\n");
  const headers = rows[0].split(",");
  return rows.slice(1).filter(Boolean).map((row) => {
    const values = row.split(",");
    const packet: Record<string, unknown> = {};
    for (let index = 0; index < headers.length; index += 1) packet[headers[index]] = Number(values[index]);
    return packet as unknown as TelemetryPacket;
  });
}

export function buildDemoFixture(packets: readonly TelemetryPacket[]): DemoSemanticFrame[] {
  const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, { simulator: "fm-2023", requested: DEMO_SEMANTIC_IDS.map((semanticId) => ({ semanticId })) });
  const slots = DEMO_SEMANTIC_IDS.map((semanticId) => resolver.slot(semanticId));
  return packets.map((packet, sequence) => {
    const timestamp = Number.isFinite(packet.TimestampMS) ? packet.TimestampMS : sequence;
    const observation: SourceObservation = { timestamp: { domain: "session", milliseconds: timestamp }, updateSequence: BigInt(sequence) };
    const view = resolver.createFrameView(packet, observation);
    const resolved = view.resolveMany(slots) as readonly ResolvedValue<unknown>[];
    const values: Record<string, unknown> = {};
    const states: Record<string, string> = {};
    const freshness: Record<string, string> = {};
    resolved.forEach((entry) => {
      values[entry.semanticId] = canonicalizeTelemetryScalar(entry.value, entry.semanticId);
      if (entry.state !== "ok") states[entry.semanticId] = entry.state;
      if (entry.freshness !== "fresh") freshness[entry.semanticId] = entry.freshness;
    });
    const slip = wheelSlipRatios(packet);
    values["tires.tire-slip-ratio"] = [slip.fl, slip.fr, slip.rl, slip.rr];
    return { values, states, freshness };
  });
}

if (import.meta.main) {
  const root = process.cwd();
  const frames = buildDemoFixture(parseCsv(join(root, "scripts/telemetry/fixtures/demo-lap.csv")));
  writeFileSync(join(root, "client/public/demo-lap.json.gz"), gzipSync(JSON.stringify({ simulator: "fm-2023", frames }), { level: 9 }));
  console.log(`Generated ${frames.length} canonical demo frames`);
}
