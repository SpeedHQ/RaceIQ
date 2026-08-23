import { useLiveEngineerStore, type LiveEngineerCallout } from "../../stores/live-engineer";
import { renderOpponentPaceText } from "../../../../server/live-strategy/live-engineer-renderer";

export function LiveEngineerOverlay({ enabled = true }: { enabled?: boolean }) {
  const callout = useLiveEngineerStore((s) => s.current);
  const dismiss = useLiveEngineerStore((s) => s.dismiss);
  const enqueueControl = useLiveEngineerStore((s) => s.enqueueControl);
  if (!enabled || !callout) return null;
  if (callout.family !== "opponent-pace") return null;
  const p = callout.render.parameters;
  return <aside role="status" aria-live="polite" className="w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-app-border bg-app-bg/95 p-4 shadow-xl">
    <p className="text-sm font-semibold">{renderOpponentPaceText(p, "exact-response")}</p>
    <p className="mt-2 text-xs text-app-text-secondary">Lap {p.playerLapNumber}: {(p.playerLapTimeMs / 1000).toFixed(3)}s · benchmark {(p.benchmarkLapTimeMs / 1000).toFixed(3)}s</p>
    {p.benchmarkDriverName && <p className="text-xs text-app-text-secondary">{p.benchmarkDriverName}{p.className ? ` · ${p.className}` : ""}</p>}
    <div className="mt-3 flex gap-2">
      <button type="button" className="rounded border border-app-border px-2 py-1 text-xs" onClick={() => enqueueControl({ type: "live-engineer-voice", protocolVersion: 1, action: "request-exact-pace", requestId: crypto.randomUUID(), decisionId: callout.decisionId })}>Speak exact pace</button>
      <button type="button" className="rounded border border-app-border px-2 py-1 text-xs" onClick={dismiss}>Dismiss</button>
    </div>
  </aside>;
}

export type { LiveEngineerCallout };
