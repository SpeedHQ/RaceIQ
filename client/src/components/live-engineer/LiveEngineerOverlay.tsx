import { useLiveEngineerStore, type LiveEngineerCallout } from "../../stores/live-engineer";

function text(callout: LiveEngineerCallout | null): string {
  if (!callout) return "";
  const p = callout.render.parameters;
  if (p.relation === "fastest-in-class") return p.scope === "class" ? "Fastest in class." : "Fastest overall.";
  if (p.relation === "setting-race-pace") return "You're setting the current race pace.";
  const delta = `${(Math.abs(p.deltaMs) / 1000).toFixed(3)} seconds`;
  const scope = p.scope === "class" ? "class" : "overall";
  if (p.relation === "outlier-lap") return `That lap is ${delta} off ${scope} pace.`;
  if (p.relation === "off-class-pace") return `You're ${delta} off ${scope} pace.`;
  return `You're ${delta} from ${scope} pace.`;
}

export function LiveEngineerOverlay() {
  const callout = useLiveEngineerStore((s) => s.current);
  const enabled = useLiveEngineerStore((s) => s.enabled);
  const dismiss = useLiveEngineerStore((s) => s.dismiss);
  const enqueueControl = useLiveEngineerStore((s) => s.enqueueControl);
  if (!enabled || !callout) return null;
  const p = callout.render.parameters;
  return <aside role="status" aria-live="polite" className="fixed bottom-4 right-4 z-40 w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-app-border bg-app-bg/95 p-4 shadow-xl">
    <p className="text-sm font-semibold">{text(callout)}</p>
    <p className="mt-2 text-xs text-app-text-secondary">Lap {p.playerLapNumber}: {(p.playerLapTimeMs / 1000).toFixed(3)}s · benchmark {(p.benchmarkLapTimeMs / 1000).toFixed(3)}s</p>
    {p.benchmarkDriverName && <p className="text-xs text-app-text-secondary">{p.benchmarkDriverName}{p.className ? ` · ${p.className}` : ""}</p>}
    <div className="mt-3 flex gap-2">
      <button type="button" className="rounded border border-app-border px-2 py-1 text-xs" onClick={() => enqueueControl({ type: "live-engineer-voice", protocolVersion: 1, action: "request-exact-pace", requestId: crypto.randomUUID(), decisionId: callout.decisionId })}>Speak exact pace</button>
      <button type="button" className="rounded border border-app-border px-2 py-1 text-xs" onClick={dismiss}>Dismiss</button>
    </div>
  </aside>;
}
