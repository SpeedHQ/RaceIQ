import { severityRangeColor } from "@raceiq/scene-3d/colors";
import type { ReplayLineSpread as LineSpreadTrace } from "../contracts/host"
import { useMessages } from "./host"
import { useSyncExternalStore } from "react";
import type { SpectateController, SpectatePair } from "../contracts/spectate";
import { windowLineSpread } from "./spectate-line-spread";

export function SpectateLineScore({ trace, pair, controller }: { trace: LineSpreadTrace | null | undefined; pair: SpectatePair; controller: SpectateController }) { const m = useMessages(); const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
const start = controller.sample(Math.max(0, snapshot.time - 1)).a?.distance;
const end = snapshot.a?.distance;
const spread = start == null || end == null || !(pair.a.distance > 0) || !pair.a.hasProgress || snapshot.time > pair.a.duration
  ? null
  : windowLineSpread(trace, start / pair.a.distance, end / pair.a.distance);
// Match the whole-lap score's five-metre full scale.
const score = spread === null ? null : Math.max(0, Math.min(100, Math.round(100 - spread * 20)));
const color = score === null ? undefined : severityRangeColor(100 - score, [20, 40]);
return (
  <section className="absolute right-3 top-3 z-20 w-40 rounded-md border border-app-border bg-app-bg/90 px-3 py-2 shadow-sm backdrop-blur-sm" aria-label={m.spectate_line_similarity()}>
    <div className="text-app-caption font-medium text-app-text-muted">{m.spectate_line_similarity()} <span className="text-app-text-dim">· 1 s</span></div>
    {score !== null && spread !== null ? (
      <>
        <div className="font-mono tabular-nums text-lg font-semibold leading-tight" style={{ color }}>{score}%</div>
        <div className="text-app-micro tabular-nums text-app-text-dim">{m.spectate_mean_spread({ spread: spread.toFixed(2) })}</div>
      </>
    ) : (
      <>
        <div className="font-mono tabular-nums text-lg font-semibold leading-tight text-app-text-dim">—</div>
        <div className="text-app-micro tabular-nums text-app-text-dim">{m.spectate_mean_spread({ spread: "—" })}</div>
      </>
    )}
  </section>
); }
