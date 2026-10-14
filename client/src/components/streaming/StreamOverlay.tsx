import { InputGraph } from "./InputGraph";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { OverlayConfig } from "@/lib/streaming-config";
import type { OverlayData, OverlayCompetitor } from "@/lib/streaming-data";
import { m } from "@/paraglide/messages";
import { CarDamageDiagram, damageColor } from "../f1/CarDamageDiagram";

const WIDGET_SIZES = {
  driving: { width: 640, height: 200 },
  inputs: { width: 640, height: 260 },
  timing: { width: 640, height: 120 },
  standings: { width: 420, height: 900 },
  nearby: { width: 420, height: 220 },
  damage: { width: 420, height: 360 },
  distance: { width: 420, height: 160 },
} as const;

export function StreamOverlay({ config, data }: { config: OverlayConfig; data: OverlayData }) {
  const size = WIDGET_SIZES[config.widget];
  const canvasRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<{ width: number; height: number }>(size);
  useLayoutEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale = Math.min(1, viewport.width / size.width, viewport.height / size.height);
  const panel = "min-w-0 max-w-full rounded-lg border border-app-border/70 bg-app-surface/95 p-3 shadow-xl backdrop-blur-sm";
  const fmt = (value: number | undefined, digits = 1) => value === undefined ? "—" : value.toFixed(digits);
  const canvas = (content: ReactNode) => (
    <div ref={canvasRef} className="absolute inset-0 overflow-hidden">
      <div className="absolute left-0 top-0" style={{ width: size.width, height: size.height, transform: `scale(${scale})`, transformOrigin: "top left" }}>
        {content}
      </div>
    </div>
  );

  if (data.status !== "live") {
    const statusText = data.status === "disconnected" ? m.streaming_disconnected() : data.status === "stale" ? m.streaming_stale() : m.streaming_waiting();
    return canvas(<div className="flex h-full w-full items-start justify-start p-2 text-app-text"><div className={`${panel} text-xs font-medium`} role="status">{statusText}</div></div>);
  }

  const competitorRows = (rows: readonly OverlayCompetitor[]) => rows.map((row) => (
    <div key={row.sourceIndex} className={`grid h-8 min-w-0 grid-cols-[2.5rem_minmax(0,1fr)_4.5rem] items-center gap-2 border-t border-app-border/60 px-2 text-xs ${row.isPlayer ? "bg-app-accent/15 text-app-accent" : "text-app-text-secondary"}`}>
      <span className="tabular-nums">{row.position}</span><span className="truncate">{row.name || "—"}</span><span className="text-right tabular-nums">{row.gapToLeaderS === undefined ? "—" : `${row.gapToLeaderS >= 0 ? "+" : ""}${fmt(row.gapToLeaderS, 3)}s`}</span>
    </div>
  ));
  if (config.widget === "driving") return canvas(<div className="flex h-full w-full items-start justify-start overflow-hidden p-2 text-app-text"><section className={`${panel} w-full`}>
    <div className="mb-2 h-1.5 overflow-hidden rounded bg-app-surface-alt"><div className="h-full bg-status-warning" style={{ width: `${(data.rpmFraction ?? 0) * 100}%` }} /></div>
    <div className="flex items-end justify-between gap-4"><div className="text-5xl font-bold leading-none tabular-nums">{data.gear ?? "—"}</div><div className="text-right"><span className="text-4xl font-bold tabular-nums">{fmt(data.speed, 0)}</span><span className="ml-2 text-sm text-app-text-muted">{data.speedUnit}</span></div><div className="text-sm tabular-nums text-app-text-muted">{data.rpm === undefined ? "—" : Math.round(data.rpm).toLocaleString()} rpm</div></div>
    <div className="mt-3 grid grid-cols-2 gap-3">{[[m.streaming_throttle(), data.throttlePct, "bg-status-success"], [m.streaming_brake(), data.brakePct, "bg-status-danger"]].map(([label, pct, color]) => <div key={String(label)}><div className="mb-1 flex justify-between text-xs"><span>{label}</span><span className="tabular-nums">{pct === undefined ? "—" : `${Math.round(Number(pct))}%`}</span></div><div className="h-1.5 rounded bg-app-surface-alt"><div className={`h-full rounded ${color}`} style={{ width: `${pct ?? 0}%` }} /></div></div>)}</div>
  </section></div>);
  if (config.widget === "timing") return canvas(<div className="flex h-full w-full items-start justify-start overflow-hidden p-2 text-app-text"><section className={`${panel} flex w-full items-center justify-between gap-5`}>
    {[[m.streaming_lap(), data.lapNumber], [m.streaming_current_time(), data.currentLapS === undefined ? undefined : `${Math.floor(data.currentLapS / 60)}:${(data.currentLapS % 60).toFixed(3).padStart(6, "0")}`], [m.streaming_position(), data.racePosition], [m.streaming_delta_to_best(), data.deltaToBestS === undefined ? undefined : `${data.deltaToBestS > 0 ? "+" : ""}${fmt(data.deltaToBestS, 3)}s`]].map(([label, value], i) => <div key={String(label)}><div className="text-app-caption uppercase tracking-wide text-app-text-muted">{label}</div><div className={`text-xl font-semibold tabular-nums ${i === 3 && data.deltaToBestS !== undefined ? data.deltaToBestS < 0 ? "text-status-success" : data.deltaToBestS > 0 ? "text-status-danger" : "text-app-text" : "text-app-text"}`}>{value ?? "—"}</div></div>)}
  </section></div>);

  if (config.widget === "inputs") return canvas(<div className="flex h-full w-full items-start justify-start overflow-hidden p-2 text-app-text"><InputGraph data={data} /></div>);
  if (config.widget === "distance") {
    const value = data.distanceDrivenM;
    const imperial = config.unit === "imperial";
    const amount = value === undefined ? "—" : imperial
      ? `${(value / 1609.344).toFixed(2)} mi`
      : `${(value / 1000).toFixed(2)} km`;
    return canvas(<div className="flex h-full w-full items-start justify-start overflow-hidden p-2 text-app-text"><section className={`${panel} flex w-full items-center justify-between`}><div><div className="text-app-caption uppercase tracking-wide text-app-text-muted">{m.streaming_distance_title()}</div><div className="mt-1 text-4xl font-semibold tabular-nums">{amount}</div></div></section></div>);
  }
  const damagePct = (semanticId: string) => data.damage.find((row) => row.semanticId === semanticId)?.pct;
  if (config.widget === "damage") return canvas(<div className="flex h-full w-full items-start justify-start overflow-hidden p-2 text-app-text"><section className={`${panel} w-full p-0`}>
    <header className="border-b border-app-border/60 px-3 py-2 text-sm font-semibold">{m.streaming_damage_title()}</header>
    {data.damageDataStatus === "unsupported"
      ? <p role="status" className="px-3 py-3 text-xs text-app-text-muted">{m.streaming_unavailable_game()}</p>
      : data.damageDataStatus === "waiting"
        ? <p role="status" className="px-3 py-3 text-xs text-app-text-muted">{m.streaming_damage_waiting()}</p>
        : <div className="flex items-center gap-4 px-3 py-4">
          {data.damage.some((row) => row.semanticId === "damage.front-left-wing-damage") ? <CarDamageDiagram className="h-60 w-28 shrink-0" damage={{
            frontLeftWingPct: damagePct("damage.front-left-wing-damage"),
            frontRightWingPct: damagePct("damage.front-right-wing-damage"),
            rearWingPct: damagePct("damage.rear-wing-damage"),
            floorPct: damagePct("damage.floor-damage"),
            diffuserPct: damagePct("damage.diffuser-damage"),
            sidepodPct: damagePct("damage.sidepod-damage"),
          }} /> : <svg viewBox="0 0 100 200" className="h-60 w-28 shrink-0" aria-hidden="true">
            <rect x="18" y="28" width="12" height="28" rx="3" fill="var(--app-surface-alt)" stroke="var(--app-border)" />
            <rect x="70" y="28" width="12" height="28" rx="3" fill="var(--app-surface-alt)" stroke="var(--app-border)" />
            <rect x="18" y="144" width="12" height="28" rx="3" fill="var(--app-surface-alt)" stroke="var(--app-border)" />
            <rect x="70" y="144" width="12" height="28" rx="3" fill="var(--app-surface-alt)" stroke="var(--app-border)" />
            <rect x="26" y="10" width="48" height="180" rx="14" fill="var(--app-surface-alt)" stroke="var(--app-border)" strokeWidth="1.5" />
            <path d="M30 38 V24 Q30 14 40 14 H60 Q70 14 70 24 V38 Z" fill={damageColor(damagePct("damage.car-damage-front"))} />
            <path d="M30 162 V176 Q30 186 40 186 H60 Q70 186 70 176 V162 Z" fill={damageColor(damagePct("damage.car-damage-rear"))} />
            <rect x="29" y="44" width="7" height="112" rx="3" fill={damageColor(damagePct("damage.car-damage-left"))} />
            <rect x="64" y="44" width="7" height="112" rx="3" fill={damageColor(damagePct("damage.car-damage-right"))} />
            <rect x="39" y="66" width="22" height="68" rx="5" fill={damageColor(damagePct("damage.car-damage-centre"))} />
            <path d="M37 60 L40 44 H60 L63 60 Z M37 140 L40 156 H60 L63 140 Z" fill="var(--app-bg)" stroke="var(--app-border)" />
          </svg>}
          <div className="min-w-0 flex-1 space-y-3">{data.damage.map(({ semanticId, labelKey, pct }) => {
          const label = labelKey === "f1live_damage_fl_wing" ? m.f1live_damage_fl_wing()
            : labelKey === "f1live_damage_fr_wing" ? m.f1live_damage_fr_wing()
              : labelKey === "f1live_damage_rear_wing" ? m.f1live_damage_rear_wing()
                : labelKey === "f1live_damage_floor" ? m.f1live_damage_floor()
                  : labelKey === "f1live_damage_diffuser" ? m.f1live_damage_diffuser()
                    : labelKey === "f1live_damage_sidepod" ? m.f1live_damage_sidepod()
                      : labelKey === "streaming_damage_front" ? m.streaming_damage_front()
                        : labelKey === "streaming_damage_rear" ? m.streaming_damage_rear()
                          : labelKey === "streaming_damage_left" ? m.streaming_damage_left()
                            : labelKey === "streaming_damage_right" ? m.streaming_damage_right() : m.streaming_damage_centre();
          return <div key={semanticId} className="flex items-center justify-between gap-3"><span className="text-xs text-app-text-muted">{label}</span><span className="text-sm font-mono font-bold tabular-nums" style={{ color: damageColor(pct) }}>{pct === undefined ? "—" : pct === 0 ? m.f1live_damage_ok() : `${pct}%`}</span></div>;
        })}</div></div>}
  </section></div>);

  const unsupported = data.raceDataStatus === "unsupported";
  const nearby = config.widget === "nearby";
  const rows = nearby ? data.nearby : data.standings;
  return canvas(<div className="flex h-full w-full items-start justify-start overflow-hidden text-app-text"><section className={`${panel} w-full p-0`}><header className="px-3 py-1 text-xs font-semibold">{nearby ? m.streaming_nearby_title() : m.streaming_standings_title()}</header>{unsupported ? <p className="px-3 pb-3 text-xs text-app-text-muted">{m.streaming_unavailable_game()}</p> : data.raceDataStatus === "waiting" ? <p className="px-3 pb-3 text-xs text-app-text-muted">{m.streaming_waiting_race()}</p> : <><div className="grid h-6 grid-cols-[2.5rem_minmax(0,1fr)_4.5rem] gap-2 px-2 text-app-caption uppercase text-app-text-muted"><span>{m.streaming_position()}</span><span>{m.streaming_driver()}</span><span className="text-right">{m.streaming_gap_to_leader()}</span></div>{competitorRows(rows)}</>}</section></div>);
}
