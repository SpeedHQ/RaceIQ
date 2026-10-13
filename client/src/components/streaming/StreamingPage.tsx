import { useMemo, useState } from "react";
import { Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import { useSettings } from "@/hooks/settings";
import { buildOverlayUrl, type OverlayConfig, type OverlayWidget } from "@/lib/streaming-config";
import { useOverlayData } from "@/hooks/useOverlayData";
import { StreamOverlay } from "./StreamOverlay";
import type { OverlayData } from "@/lib/streaming-data";

const SAMPLE_STANDINGS: OverlayData["standings"] = [
  { sourceIndex: 0, position: 1, name: "A. Driver", gapToLeaderS: 0, isPlayer: false },
  { sourceIndex: 1, position: 2, name: "B. Racer", gapToLeaderS: 1.284, isPlayer: false },
  { sourceIndex: 2, position: 3, name: "You", gapToLeaderS: 2.617, isPlayer: true },
  { sourceIndex: 3, position: 4, name: "D. Speed", gapToLeaderS: 4.103, isPlayer: false },
  { sourceIndex: 4, position: 5, name: "E. Apex", gapToLeaderS: 5.776, isPlayer: false },
];

function sampleOverlayData(unit: OverlayConfig["unit"]): OverlayData {
  return {
    status: "live",
    speed: unit === "metric" ? 234 : 145,
    speedUnit: unit === "metric" ? "km/h" : "mph",
    gear: "4",
    rpm: 8420,
    rpmFraction: 0.84,
    throttlePct: 82,
    brakePct: 0,
    clutchPct: 15,
    lapNumber: 8,
    currentLapS: 74.326,
    racePosition: 3,
    deltaToBestS: -0.218,
    standings: SAMPLE_STANDINGS,
    nearby: SAMPLE_STANDINGS.slice(1, 4),
    raceDataStatus: "available",
    damage: [
      { semanticId: "damage.car-damage-front", labelKey: "streaming_damage_front", pct: 12 },
      { semanticId: "damage.car-damage-rear", labelKey: "streaming_damage_rear", pct: 0 },
      { semanticId: "damage.car-damage-left", labelKey: "streaming_damage_left", pct: 4 },
      { semanticId: "damage.car-damage-right", labelKey: "streaming_damage_right", pct: 18 },
      { semanticId: "damage.car-damage-centre", labelKey: "streaming_damage_centre", pct: 7 },
    ],
    damageDataStatus: "available",
  };
}

const WIDGETS: readonly { widget: OverlayWidget; width: number; height: number; title: () => string; explain: () => string }[] = [
  { widget: "driving", width: 640, height: 200, title: () => m.streaming_driving_title(), explain: () => m.streaming_driving_description() },
  { widget: "inputs", width: 640, height: 260, title: () => m.streaming_inputs_title(), explain: () => m.streaming_inputs_description() },
  { widget: "timing", width: 640, height: 120, title: () => m.streaming_timing_title(), explain: () => m.streaming_timing_description() },
  { widget: "standings", width: 420, height: 900, title: () => m.streaming_standings_title(), explain: () => m.streaming_standings_description() },
  { widget: "nearby", width: 420, height: 220, title: () => m.streaming_nearby_title(), explain: () => m.streaming_nearby_description() },
  { widget: "damage", width: 420, height: 360, title: () => m.streaming_damage_title(), explain: () => m.streaming_damage_description() },
];

function OverlayPreview({ config }: { config: OverlayConfig }) {
  const liveData = useOverlayData(config);
  const isSample = liveData.status !== "live";
  const data = isSample ? sampleOverlayData(config.unit) : liveData;
  return <div className="relative aspect-video overflow-hidden rounded-md" style={{ backgroundColor: "transparent", backgroundImage: "linear-gradient(45deg,color-mix(in srgb,var(--app-text) 8%,transparent) 25%,transparent 25%),linear-gradient(-45deg,color-mix(in srgb,var(--app-text) 8%,transparent) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,color-mix(in srgb,var(--app-text) 8%,transparent) 75%),linear-gradient(-45deg,transparent 75%,color-mix(in srgb,var(--app-text) 8%,transparent) 75%)", backgroundSize: "16px 16px", backgroundPosition: "0 0,0 8px,8px -8px,-8px 0" }}><div className="absolute inset-0 origin-top-left" style={{ transform: "scale(.55)", width: "182%", height: "182%" }}><StreamOverlay config={config} data={data} /></div>{isSample && <span className="absolute right-2 top-2 rounded bg-app-surface/90 px-2 py-1 text-xs font-medium text-app-text">{m.streaming_sample_data()}</span>}</div>;
}

export function StreamingPage() {
  const { displaySettings } = useSettings();
  const [unit, setUnit] = useState<"metric" | "imperial">(displaySettings.unit);
  const [feedback, setFeedback] = useState<Record<string, "copied" | "manual" | undefined>>({});
  const urls = useMemo(() => Object.fromEntries(WIDGETS.map(({ widget }) => [widget, buildOverlayUrl(window.location.origin, { widget, unit })])) as Record<OverlayWidget, string>, [unit]);
  async function copyUrl(widget: OverlayWidget) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(urls[widget]);
      setFeedback((current) => ({ ...current, [widget]: "copied" }));
    } catch {
      setFeedback((current) => ({ ...current, [widget]: "manual" }));
    }
  }
  return <main className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-xl font-semibold">{m.streaming_title()}</h1><p className="mt-1 max-w-3xl text-sm text-app-text-muted">{m.streaming_intro()}</p></div><label className="flex items-center gap-2 text-sm">{m.streaming_units()}<select className="rounded-md border border-app-border bg-app-surface px-3 py-2" value={unit} onChange={(event) => setUnit(event.target.value as "metric" | "imperial")}><option value="metric">{m.streaming_metric()}</option><option value="imperial">{m.streaming_imperial()}</option></select></label></header>
    <section className="rounded-lg border border-app-border bg-app-surface p-4"><h2 className="mb-2 text-sm font-semibold">{m.streaming_obs_steps_title()}</h2><ol className="list-inside list-decimal space-y-1 text-sm text-app-text-secondary"><li>{m.streaming_obs_step_one()}</li><li>{m.streaming_obs_step_two()}</li><li>{m.streaming_obs_step_three()}</li><li>{m.streaming_obs_step_four()}</li></ol><p className="mt-3 text-xs text-app-text-muted">{m.streaming_game_running_note()}</p><p className="mt-1 text-xs text-app-text-muted">{m.streaming_f1_semantics_note()}</p></section>
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">{WIDGETS.map(({ widget, width, height, title, explain }) => {
      const config: OverlayConfig = { widget, unit };
      return <article key={widget} className="min-w-0 rounded-lg border border-app-border bg-app-surface p-4"><div className="flex items-center gap-2"><Video className="size-4 text-app-accent"/><h2 className="font-semibold">{title()}</h2></div><p className="my-2 min-h-10 text-sm text-app-text-muted">{explain()}</p><OverlayPreview config={config}/><p className="mt-2 text-xs text-app-text-muted">{m.streaming_recommended_size({ width, height })} · {m.streaming_fps()}</p><label className="mt-3 block text-xs font-medium">{m.streaming_source_url()}<input readOnly value={urls[widget]} onFocus={(event) => event.currentTarget.select()} className="mt-1 w-full rounded-md border border-app-border bg-app-bg px-2 py-2 font-mono text-xs" aria-label={m.streaming_source_url()}/></label><div className="mt-2 flex flex-wrap gap-2"><Button variant="app-outline" size="app-sm" onClick={() => void copyUrl(widget)}>{m.streaming_copy_url()}</Button><a className="inline-flex min-h-8 items-center rounded-md border border-app-border px-3 text-xs font-medium hover:bg-app-surface-hover" href={urls[widget]} target="_blank" rel="noopener noreferrer">{m.streaming_open_preview()}</a></div>{feedback[widget] && <p className="mt-2 text-xs" role="status">{feedback[widget] === "copied" ? m.streaming_copy_success() : m.streaming_manual_copy()}</p>}</article>;
    })}</section>
  </main>;
}
