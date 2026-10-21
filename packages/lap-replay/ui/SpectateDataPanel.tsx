import { useMemo, useState, useSyncExternalStore } from "react";
import { semanticValues, type SemanticAnalysisFrame } from "@raceiq/scene-3d/semantic-frame";
import { AnalyseDataContent } from "./host"
import { SpectateLapTabs } from "./SpectateLapTabs";
import { useMessages } from "./host"
import type { SpectateController, SpectatePair } from "../contracts/spectate";

export function SpectateDataPanel({ pair, controller }: { pair: SpectatePair; controller: SpectateController }) { const m = useMessages(); const [side, setSide] = useState<"a" | "b">("a");
const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
const lap = pair[side];
const reading = snapshot[side];
let lo = 0, hi = lap.samples.length;
while (lo < hi) {
  const mid = (lo + hi) >>> 1;
  if (lap.samples[mid]!.time <= (reading?.time ?? -Infinity)) lo = mid + 1;
  else hi = mid;
}
const envelope = reading && reading.time <= lap.duration && Object.keys(reading.values).length > 0 ? lap.samples[lo - 1]?.frame : undefined;
const metadata = side === "a" ? pair.comparison.lapA : pair.comparison.lapB;
const currentFrame = useMemo<SemanticAnalysisFrame | null>(() => envelope ? {
  values: semanticValues(envelope.values),
  states: Object.fromEntries(envelope.values.map((entry) => [entry.semanticId, entry.state])),
  freshness: Object.fromEntries(envelope.values.map((entry) => [entry.semanticId, entry.freshness])),
  units: Object.fromEntries(envelope.values.map((entry) => [entry.semanticId, entry.unit])),
  source: metadata.source ?? null,
  observedAt: envelope.observedAt,
  observedAtMs: envelope.observedAt.milliseconds,
  ...(envelope.lmu ? { lmu: envelope.lmu } : {}),
} : null, [envelope, metadata.source]);
const fuel = lap.samples[0]?.values["fuel.fuel"];
const wearRate = useMemo(() => {
  const current = lap.samples[lo - 1];
  const previous = lap.samples[Math.max(0, lo - 61)];
  if (!current || !previous || current.run !== previous.run || current.time - previous.time <= 0.1) return null;
  const wear = current.values["tires.tire-wear"];
  const prior = previous.values["tires.tire-wear"];
  if (!Array.isArray(wear) || !Array.isArray(prior)) return null;
  const rates = [0, 1, 2, 3].map((index) => typeof wear[index] === "number" && typeof prior[index] === "number" ? (wear[index] - prior[index]) / (current.time - previous.time) : NaN);
  return rates.every(Number.isFinite) ? { FL: rates[0]!, FR: rates[1]!, RL: rates[2]!, RR: rates[3]! } : null;
}, [lap, lo]);
return (
  <div data-spectate-data-side={side}>
    <SpectateLapTabs side={side} onSideChange={setSide}>
        {!currentFrame && <p role="status" className="p-3 text-app-detail text-app-text-muted">{m.spectate_replay_unavailable()}</p>}
        <AnalyseDataContent key={side} currentFrame={currentFrame} packetNumber={envelope?.sequence ?? 0} startFuel={typeof fuel === "number" ? fuel : undefined} gameId={pair.gameId} wearRate={currentFrame ? wearRate : null} />
    </SpectateLapTabs>
  </div>
); }
