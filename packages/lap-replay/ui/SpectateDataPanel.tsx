import { useMemo, useState, useSyncExternalStore } from "react";
import { semanticValues, type SemanticAnalysisFrame } from "@raceiq/scene-3d/semantic-frame";
import { AnalyseDataContent } from "./host"
import { SpectateLapTabs } from "./SpectateLapTabs";
import { useMessages } from "./host"
import type { SpectateController, ReplaySession } from "../contracts/spectate";

export function SpectateDataPanel({ pair, controller }: { pair: ReplaySession; controller: SpectateController }) { const m = useMessages(); const [side, setSide] = useState<"a" | "b">("a");
const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
const lap = side === "b" && pair.b ? pair.b : pair.a;
const reading = side === "b" && pair.b ? snapshot.b : snapshot.a;
let lo = 0, hi = lap.samples.length;
while (lo < hi) {
  const mid = (lo + hi) >>> 1;
  if (lap.samples[mid]!.time <= (reading?.time ?? -Infinity)) lo = mid + 1;
  else hi = mid;
}
const envelope = reading && reading.time <= lap.duration && Object.keys(reading.values).length > 0 ? lap.samples[lo - 1]?.frame : undefined;
const metadata = side === "a" ? pair.comparison.lapA : pair.comparison.lapB ?? pair.comparison.lapA;
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
const envelopeIndexBySequence = useMemo(() => new Map(lap.replay.envelopes.map((frame, index) => [frame.sequence, index] as const)), [lap.replay.envelopes]);
const envelopeIndex = envelope ? envelopeIndexBySequence.get(envelope.sequence) ?? -1 : -1;
const content = <>
  {!currentFrame && <p role="status" className="p-3 text-app-detail text-app-text-muted">{m.spectate_replay_unavailable()}</p>}
  <AnalyseDataContent key={side} currentFrame={currentFrame} packetNumber={pair.b ? envelope?.sequence ?? 0 : envelopeIndex + 1} startFuel={typeof fuel === "number" ? fuel : undefined} gameId={pair.gameId} wearRate={currentFrame ? wearRate : null} />
</>;
return <div data-spectate-data-side={pair.b ? side : "a"} data-packet-number={envelopeIndex + 1} data-packet-count={lap.replay.envelopes.length}>
  {pair.b ? <SpectateLapTabs side={side} onSideChange={setSide}>{content}</SpectateLapTabs> : content}
</div>;
}
