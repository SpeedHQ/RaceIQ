import type { AnalysisTelemetryMetric } from "@raceiq/shared/games/types";
import { resolveAnalysisTelemetry } from "@raceiq/shared/racing/analysis/telemetry-capabilities";
import { resolveBalance, resolveGripDemand } from "@raceiq/analysis-core/racing/analysis/metric-values";
import { suspensionCompressionBias } from "@raceiq/analysis-core/racing/analysis/laps/physics/vehicle";
import { getGame } from "@raceiq/shared/games/registry";
import { isTelemetryVariableId, getTelemetryVariable } from "@raceiq/shared/telemetry/catalog/query";
import type { SpectatePair, SpectateReading } from "./types";

export interface SpectateChannel {
  id: string;
  label: string;
  unit: string;
  components: readonly { key: string; label: string }[];
  derived?: "delta" | "g-force" | "balance" | "grip" | "compression-bias" | "wear-rate";
  metric?: AnalysisTelemetryMetric;
  delta?: { distance: readonly number[]; values: readonly number[] };
  wearRate?: { a: readonly { time: number; run: number; rates: readonly (number | null)[] }[]; b: readonly { time: number; run: number; rates: readonly (number | null)[] }[] };
}
const numeric = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function buildSpectateChannels(pair: SpectatePair): SpectateChannel[] {
  const ids = [
    ...new Set([
      ...pair.a.replay.requestedSemanticIds,
      ...pair.b.replay.requestedSemanticIds,
      ...pair.a.samples.flatMap((sample) => Object.keys(sample.values)),
      ...pair.b.samples.flatMap((sample) => Object.keys(sample.values)),
    ]),
  ];
  const channels: SpectateChannel[] = [];
  for (const id of ids) {
    if (!isTelemetryVariableId(id)) continue;
    const meta = getTelemetryVariable(id);
    if (meta.valueType !== "number") continue;
    const components =
      meta.shape === "per-wheel"
        ? ["FL", "FR", "RL", "RR"].map((label, i) => ({ key: String(i), label }))
        : meta.shape === "vector" || meta.shape === "array"
          ? meta.dimensions.map((label, i) => ({ key: String(i), label: label || String(i + 1) }))
          : [{ key: "", label: "" }];
    channels.push({ id, label: meta.label, unit: meta.canonicalUnit, components });
  }
  const analysis = resolveAnalysisTelemetry(getGame(pair.gameId));
  for (const [name, metric, derivation, label, unit] of [
    ["gForce", analysis.gForce, "g-force-v1", "G force", "g"],
    ["balance", analysis.balance, "physical-balance-v1", "Balance", "ratio"],
    ["gripDemand", analysis.gripDemand, "friction-circle-v1", "Grip demand", "ratio"],
  ] as const) {
    const isGrip = name === "gripDemand";
    const supported = isGrip
      ? metric.source !== "unavailable" && (metric.binding?.kind === "value" || (metric.binding?.kind === "derived" && metric.binding.derivation === derivation))
      : metric.source === "derived" && metric.binding?.kind === "derived" && metric.binding.derivation === derivation;
    if (!supported) continue;
    channels.push({
      id: `derived.${name}`,
      label,
      unit,
      metric,
      components: isGrip ? ["FL", "FR", "RL", "RR"].map((label, i) => ({ key: String(i), label })) : [{ key: "", label: "" }],
      derived: name === "gForce" ? "g-force" : name === "balance" ? "balance" : "grip",
    });
  }
  const compressionMetric = analysis.suspensionCompressionBias;
  if (compressionMetric.source === "derived" && compressionMetric.binding?.kind === "derived" && compressionMetric.binding.derivation === "compression-bias-v1") {
    channels.push({
      id: "derived.suspensionCompressionBias",
      label: "Compression bias",
      unit: "ratio",
      metric: compressionMetric,
      components: [
        { key: "front", label: "Front" },
        { key: "left", label: "Left" },
      ],
      derived: "compression-bias",
    });
  }
  const wearMetric = analysis.tireWearRate;
  if (wearMetric.source === "derived" && wearMetric.binding?.kind === "derived" && wearMetric.binding.derivation === "wear-rate-v1") {
    const semanticId = wearMetric.binding.requires[0]!;
    channels.push({
      id: "derived.tireWearRate",
      label: "Tire wear rate",
      unit: "fraction/s",
      metric: wearMetric,
      components: ["FL", "FR", "RL", "RR"].map((label, i) => ({ key: String(i), label })),
      derived: "wear-rate",
      wearRate: { a: buildWearHistory(pair.a.samples, semanticId), b: buildWearHistory(pair.b.samples, semanticId) },
    });
  }
  channels.push({
    id: "comparison.time-delta",
    label: "Time delta",
    unit: "s",
    components: [{ key: "", label: "" }],
    derived: "delta",
    delta: { distance: pair.comparison.traces.distance, values: pair.comparison.timeDelta },
  });
  return channels;
}

function finiteWheels(value: unknown): value is number[] {
  return Array.isArray(value) && value.length >= 4 && value.slice(0, 4).every(numeric);
}

function buildWearHistory(samples: SpectatePair["a"]["samples"], semanticId: string): { time: number; run: number; rates: readonly (number | null)[] }[] {
  const result: { time: number; run: number; rates: readonly (number | null)[] }[] = [];
  let previous: { time: number; run: number; wheels: number[] } | null = null;
  for (const sample of samples) {
    const wheels = sample.values[semanticId];
    if (!finiteWheels(wheels)) {
      previous = null;
      continue;
    }
    result.push({
      time: sample.time,
      run: sample.run,
      rates:
        previous && previous.run === sample.run && sample.time > previous.time
          ? wheels.slice(0, 4).map((value, index) => (value - previous!.wheels[index]!) / (sample.time - previous!.time))
          : [null, null, null, null],
    });
    previous = { time: sample.time, run: sample.run, wheels: wheels.slice(0, 4) };
  }
  return result;
}

export function channelValue(reading: SpectateReading | null, channel: SpectateChannel, component: string, side: "a" | "b" = "a"): number | null {
  if (channel.derived === "delta") {
    const distance = reading?.distance,
      grid = channel.delta?.distance,
      values = channel.delta?.values;
    if (distance == null || !grid?.length || !values || distance < grid[0]! || distance > grid.at(-1)!) return null;
    let lo = 0,
      hi = grid.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (grid[mid]! < distance) lo = mid + 1;
      else hi = mid;
    }
    if (grid[lo] === distance) return numeric(values[lo]) ? values[lo]! : null;
    const before = lo - 1,
      left = values[before],
      right = values[lo];
    if (!numeric(left) || !numeric(right) || grid[lo]! <= grid[before]!) return null;
    return left + ((right - left) * (distance - grid[before]!)) / (grid[lo]! - grid[before]!);
  }
  if (channel.derived && reading) {
    const metric = channel.metric;
    if (!metric || metric.source === "unavailable") return null;
    const frame = { values: reading.values };
    if (channel.derived === "grip") {
      const values = resolveGripDemand(frame, metric);
      const value = values[Number(component)];
      return numeric(value) ? value : null;
    }
    if (channel.derived === "wear-rate") {
      if (metric.source !== "derived" || metric.binding?.kind !== "derived" || metric.binding.derivation !== "wear-rate-v1" || !channel.wearRate) return null;
      if (!finiteWheels(reading.values[metric.binding.requires[0]!])) return null;
      const history = channel.wearRate[side];
      let lo = 0,
        hi = history.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (history[mid]!.time < reading.time) lo = mid + 1;
        else hi = mid;
      }
      const index = history[lo]?.time === reading.time ? lo : lo - 1;
      const current = history[index],
        next = history[index + 1];
      if (!current || reading.time < current.time) return null;
      if (reading.time !== current.time && (!next || current.run !== next.run || reading.time > next.time)) return null;
      const value = current.rates[Number(component)];
      return numeric(value) ? value : null;
    }
    if (channel.derived === "compression-bias") {
      const binding = metric.binding;
      if (metric.source !== "derived" || binding?.kind !== "derived" || binding.derivation !== "compression-bias-v1") return null;
      const raw = reading.values[binding.requires[0]!];
      if (!finiteWheels(raw)) return null;
      const values = suspensionCompressionBias([raw[0]!, raw[1]!, raw[2]!, raw[3]!]);
      return component === "front" ? values.front : component === "left" ? values.left : null;
    }
    if (metric.source !== "derived" || metric.binding?.kind !== "derived") return null;
    const required = metric.binding.requires;
    if (channel.derived === "g-force") {
      if (required.some((id) => !numeric(reading.values[id]))) return null;
      const x = reading.values[required[0]],
        z = reading.values[required[1]];
      return typeof x === "number" && typeof z === "number" ? Math.hypot(x, z) / 9.80665 : null;
    }
    return resolveBalance(frame, metric)?.balance ?? null;
  }
  const raw = reading?.values[channel.id];
  if (component === "") return numeric(raw) ? raw : null;
  if (Array.isArray(raw)) {
    const value = raw[Number(component)];
    return numeric(value) ? value : null;
  }
  if (raw && typeof raw === "object") {
    const index = Number(component);
    const key = Number.isInteger(index) ? (["FL", "FR", "RL", "RR"][index] ?? component) : component;
    const values = raw as Record<string, unknown>;
    const value = values[component] ?? values[key];
    return numeric(value) ? value : null;
  }
  return null;
}
