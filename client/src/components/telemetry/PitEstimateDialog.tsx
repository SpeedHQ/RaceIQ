import { useId } from "react";
import type { GameId } from "@raceiq/shared/games/ids";
import type { LivePitData } from "@raceiq/shared/racing/live/types";
import type { LiveStrategy } from "@raceiq/shared/racing/live/strategy";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { m } from "@/paraglide/messages";
import { strategyRateText } from "@/lib/strategy-format";
import { StrategyHistory } from "./StrategyHistory";
import { RaceStrategyPlanner } from "./RaceStrategyPlanner";

type TireReading = {
  label: "FL" | "FR" | "RL" | "RR";
  health: number | null;
  healthColor: string;
  wearPerLap: string | null;
  toCliff: number | null;
  toDead: number | null;
  cliffPct: number | null;
  deadPct: number | null;
};

type Marker = { kind: "now" | "fuel" | "cliff" | "dead"; lap: number; laps: number };

function formatLaps(value: number | null) {
  return value == null || !Number.isFinite(value) || value < 0 ? m.strategy_unavailable() : value.toFixed(1);
}

function thresholdHeader(label: string, values: (number | null)[]) {
  const present = values.filter((value): value is number => value != null && Number.isFinite(value));
  const unique = [...new Set(present)];
  if (present.length === 0) return `${label} ${m.strategy_unavailable()}`;
  return unique.length === 1 && present.length === values.length ? `${label} ${unique[0]}%` : `${label} · ${m.pit_mixed_thresholds()}`;
}

export function PitEstimateDialog({ gameId, sessionId, currentLap, carId, trackId, pi, pit, fuelAmount, fuelUnit, strategy, tires, historyDriverKey }: {
  gameId: GameId;
  sessionId: number | null;
  currentLap: number | null;
  carId: string | null;
  trackId: string | null;
  pi: number | null;
  pit: LivePitData | null;
  fuelAmount: number | null;
  fuelUnit: string;
  strategy: LiveStrategy | null;
  tires: TireReading[];
  historyDriverKey: string | null;
}) {
  const titleId = useId();
  const horizon = currentLap != null && Number.isFinite(currentLap) && currentLap >= 1 ? currentLap : null;
  const strategyFuelRate = strategy?.fuel.value;
  const liveFuelRate = pit?.fuelPerLap;
  const fuelRate = strategyFuelRate != null && Number.isFinite(strategyFuelRate) && strategyFuelRate >= 0
    ? strategyRateText(strategy!.fuel)
    : liveFuelRate != null && Number.isFinite(liveFuelRate) && liveFuelRate > 0
      ? fuelUnit === "L"
        ? m.strategy_rate_litres({ value: liveFuelRate.toFixed(2) })
        : m.strategy_rate_points({ value: (liveFuelRate * 100).toFixed(1) })
      : null;
  const validFuelRate = fuelRate != null;
  const fuelLaps = validFuelRate && pit?.fuelLapsRemaining != null && Number.isFinite(pit.fuelLapsRemaining) && pit.fuelLapsRemaining >= 0 ? pit.fuelLapsRemaining : null;
  const firstCliff = tires.reduce<number | null>((first, tire) => tire.toCliff == null || !Number.isFinite(tire.toCliff) || tire.toCliff < 0 ? first : first == null ? tire.toCliff : Math.min(first, tire.toCliff), null);
  const firstDead = tires.reduce<number | null>((first, tire) => tire.toDead == null || !Number.isFinite(tire.toDead) || tire.toDead < 0 ? first : first == null ? tire.toDead : Math.min(first, tire.toDead), null);
  const projectionLaps = [fuelLaps, firstCliff, firstDead].filter((value): value is number => value != null);
  const displayLaps = Math.max(8, Math.ceil(Math.max(...projectionLaps, 0) + 2));
  const markers: Marker[] = horizon == null ? [] : [
    { kind: "now", lap: horizon, laps: 0 },
    ...(fuelLaps == null ? [] : [{ kind: "fuel" as const, lap: horizon + fuelLaps, laps: fuelLaps }]),
    ...(firstCliff == null ? [] : [{ kind: "cliff" as const, lap: horizon + firstCliff, laps: firstCliff }]),
    ...(firstDead == null ? [] : [{ kind: "dead" as const, lap: horizon + firstDead, laps: firstDead }]),
  ];
  const maxMarkerLaps = Math.max(displayLaps, ...projectionLaps);
  const graphRange = maxMarkerLaps > displayLaps ? Math.ceil(maxMarkerLaps) : displayLaps;
  const sortedMarkers = [...markers].sort((a, b) => a.laps - b.laps);
  const laneEnds: number[] = [];
  const markerLanes = new Map<Marker["kind"], number>();
  for (const marker of sortedMarkers) {
    const x = marker.laps / graphRange * 600;
    let lane = laneEnds.findIndex((end) => x >= end);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = x + 150;
    markerLanes.set(marker.kind, lane);
  }
  const markerLabel = (marker: Marker) => {
    const label = marker.kind === "now" ? m.pit_timeline_now() : marker.kind === "fuel" ? m.pit_timeline_fuel_limit() : marker.kind === "cliff" ? m.pit_timeline_first_cliff() : m.pit_timeline_first_dead();
    const position = marker.laps / graphRange;
    const left = position <= 0.11 ? "12px" : position >= 0.89 ? "calc(100% - 12px)" : `calc(12px + (100% - 24px) * ${position})`;
    const transform = position <= 0.11 ? "none" : position >= 0.89 ? "translateX(-100%)" : "translateX(-50%)";
    return <span key={marker.kind} className="absolute z-10 w-32 text-center text-xs leading-tight" style={{ left, transform, top: `${Math.floor((markerLanes.get(marker.kind) ?? 0) / 2) * 42 + ((markerLanes.get(marker.kind) ?? 0) % 2 ? 205 : 0)}px` }}>
      <strong className="block font-semibold text-app-text">{label}</strong>
      <span className="block text-app-text-muted">{marker.kind === "now" ? m.pit_timeline_lap({ lap: marker.lap }) : m.pit_timeline_marker_value({ lap: marker.lap.toFixed(1), laps: formatLaps(marker.laps) })}</span>
    </span>;
  };
  const thresholdTuple = (kind: "cliffPct" | "deadPct") => tires.map((tire) => tire[kind]);
  const mixedCliff = new Set(thresholdTuple("cliffPct")).size > 1;
  const mixedDead = new Set(thresholdTuple("deadPct")).size > 1;
  const rangeEnd = horizon == null ? null : horizon + graphRange;
  const limiter = pit?.limitedBy === "fuel" ? m.pit_timeline_fuel_first() : pit?.limitedBy === "tires" ? m.pit_timeline_tires_first() : pit?.limitedBy === null ? m.pit_timeline_no_limiter() : m.strategy_unavailable();

  return <Dialog>
    <DialogTrigger render={<Button variant="outline" size="sm" className="shrink-0">{m.pit_timeline_open()}</Button>} />
    <DialogContent size="wide" layout="scrollable" className="max-h-[90dvh] min-w-0 gap-0 overflow-x-hidden p-0">
      <DialogHeader className="border-b border-app-border px-5 py-4 pr-12 sm:px-7">
        <DialogTitle id={titleId} className="text-2xl font-semibold tracking-tight">{m.pit_timeline_title()}</DialogTitle>
        <DialogDescription>{m.pit_timeline_description()}</DialogDescription>
      </DialogHeader>
      <div className="min-w-0 space-y-5 p-4 sm:p-6">
        <section aria-labelledby={`${titleId}-horizon`} className="rounded-xl border border-app-border bg-app-bg p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 id={`${titleId}-horizon`} className="text-sm font-semibold uppercase tracking-wide">{m.pit_timeline_horizon()}</h2><p className="mt-1 text-xs text-app-text-muted">{m.pit_timeline_horizon_note()}</p></div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-app-text-muted"><span><i className="mr-1 inline-block size-2.5 rounded-full bg-(--severity-caution)" />{m.pit_timeline_fuel_limit()}</span><span><i className="mr-1 inline-block size-2.5 rounded-full bg-app-accent" />{m.pit_cliff()}</span><span><i className="mr-1 inline-block size-2.5 rounded-full bg-app-text-dim" />{m.pit_dead()}</span></div>
          </div>
          {horizon == null ? <p role="status" className="mt-4 text-sm text-app-text-muted">{m.pit_timeline_lap_unavailable()}</p> : <div className="mt-4 overflow-x-auto rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-accent" role="group" aria-label={m.pit_timeline_horizon_scroll()} tabIndex={0}>
            <div className="relative mx-auto h-[330px] min-w-[600px] px-3" role="img" aria-label={m.pit_timeline_chart_description({ now: String(horizon), end: String(rangeEnd), fuel: fuelLaps == null ? m.strategy_unavailable() : (horizon + fuelLaps).toFixed(1), cliff: firstCliff == null ? m.strategy_unavailable() : (horizon + firstCliff).toFixed(1), dead: firstDead == null ? m.strategy_unavailable() : (horizon + firstDead).toFixed(1) })}>
              <div className="absolute inset-x-3 top-[164px] h-1 rounded-full bg-app-border" />
              {Array.from({ length: 7 }, (_, index) => {
                const position = index / 6;
                const lap = horizon + graphRange * position;
                return <div key={index} className="absolute top-[159px] h-3 w-px bg-app-text-dim/50" style={{ left: `calc(12px + (100% - 24px) * ${position})` }}><span className="absolute left-1/2 top-5 -translate-x-1/2 whitespace-nowrap text-xs text-app-text-muted">{lap.toFixed(0)}</span></div>;
              })}
              {markers.map((marker) => <div key={`stem-${marker.kind}`} className={`absolute top-[74px] h-[92px] w-px ${marker.kind === "fuel" ? "bg-(--severity-caution)" : marker.kind === "dead" ? "bg-app-text-dim" : "bg-app-accent"}`} style={{ left: `calc(12px + (100% - 24px) * ${marker.laps / graphRange})` }}><span className={`absolute -left-[7px] top-[85px] size-3.5 rounded-full border-2 border-app-surface ${marker.kind === "fuel" ? "bg-(--severity-caution)" : marker.kind === "dead" ? "bg-app-text-dim" : "bg-app-accent"}`} /></div>)}
              {markers.map(markerLabel)}
              <div className="absolute inset-x-3 top-[298px] flex justify-between text-xs text-app-text-muted"><span>{m.pit_timeline_current_lap()}</span><span>{m.pit_timeline_end_label({ lap: String(rangeEnd), laps: String(graphRange) })}</span></div>
            </div>
          </div>}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-app-border pt-3 text-sm text-app-text-muted"><span>{limiter}</span><strong className="font-semibold text-app-text">{pit?.pitInLaps != null && Number.isFinite(pit.pitInLaps) && pit.pitInLaps >= 0 ? m.pit_timeline_pit_in({ laps: pit.pitInLaps.toFixed(1) }) : m.strategy_unavailable()}</strong></div>
        </section>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <section className="rounded-xl border border-app-border bg-app-surface p-4"><div className="text-xs font-semibold uppercase tracking-wide text-app-text-muted">{m.pit_timeline_fuel_remaining()}</div><strong className="mt-1 block text-2xl font-mono tabular-nums">{fuelAmount == null ? m.strategy_unavailable() : `${fuelAmount.toFixed(fuelUnit === "L" ? 1 : 0)} ${fuelUnit}`}</strong><p className="mt-1 text-sm text-app-text-muted">{validFuelRate ? m.pit_timeline_fuel_rate({ rate: fuelRate }) : m.pit_timeline_rate_unavailable()}</p><span className="mt-2 inline-flex rounded-full bg-app-bg px-2.5 py-1 text-xs font-semibold text-app-text-secondary">{fuelLaps == null ? m.pit_timeline_projection_unavailable() : m.pit_timeline_laps_remaining({ laps: formatLaps(fuelLaps) })}</span></section>
          <section className="rounded-xl border border-app-border bg-app-surface p-4"><div className="text-xs font-semibold uppercase tracking-wide text-app-text-muted">{m.pit_timeline_stint_estimate()}</div><strong className="mt-1 block text-2xl font-mono tabular-nums">{horizon == null ? m.strategy_unavailable() : m.pit_timeline_lap({ lap: horizon })}</strong><p className="mt-1 text-sm text-app-text-muted">{strategy ? m.pit_timeline_eligible_laps({ count: strategy.fuel.eligibleLaps }) : m.pit_timeline_stint_unavailable()}</p><span className="mt-2 inline-flex rounded-full bg-app-bg px-2.5 py-1 text-xs font-semibold text-app-text-secondary">{strategy?.fuel.provisional ? m.race_result_provisional() : strategy?.fuel.source ? m.pit_timeline_estimate_current() : m.strategy_unavailable()}</span></section>
          <section className="rounded-xl border border-app-border bg-app-surface p-4 sm:col-span-2 lg:col-span-1"><div className="text-xs font-semibold uppercase tracking-wide text-app-text-muted">{m.pit_timeline_thresholds()}</div><strong className="mt-1 block text-lg font-mono tabular-nums">{thresholdHeader(m.pit_cliff(), thresholdTuple("cliffPct"))}</strong><p className="text-sm text-app-text-muted">{thresholdHeader(m.pit_dead(), thresholdTuple("deadPct"))}</p><span className="mt-2 inline-flex rounded-full bg-app-bg px-2.5 py-1 text-xs font-semibold text-app-text-secondary">{firstCliff == null ? m.pit_timeline_cliff_unavailable() : m.pit_timeline_first_tire({ wheel: tires.find((tire) => tire.toCliff === firstCliff)?.label ?? "—" })}</span></section>
        </div>

        <section aria-labelledby={`${titleId}-tires`}>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2"><h2 id={`${titleId}-tires`} className="text-sm font-semibold uppercase tracking-wide">{m.pit_timeline_tire_readings()}</h2><span className="text-xs text-app-text-muted">{m.pit_timeline_reading_note()}</span></div>
          <div className="overflow-x-auto rounded-xl border border-app-border"><table className="w-full min-w-[650px] border-collapse text-right text-sm"><caption className="sr-only">{m.pit_timeline_tire_readings()}</caption><thead className="bg-app-bg text-xs uppercase tracking-wide text-app-text-muted"><tr><th scope="col" className="px-3 py-2 text-left">{m.pit_timeline_corner()}</th><th scope="col" className="px-3 py-2">{m.pit_health()}</th><th scope="col" className="px-3 py-2">{m.pit_wear_lap()}</th><th scope="col" className="px-3 py-2">{thresholdHeader(m.pit_cliff(), thresholdTuple("cliffPct"))}</th><th scope="col" className="px-3 py-2">{thresholdHeader(m.pit_dead(), thresholdTuple("deadPct"))}</th></tr></thead><tbody>{tires.map((tire) => <tr key={tire.label} className="border-t border-app-border"><th scope="row" className="px-3 py-2 text-left font-semibold">{tire.label}</th><td className="px-3 py-2 font-mono tabular-nums" style={{ color: tire.healthColor }}>{tire.health == null ? m.strategy_unavailable() : `${tire.health.toFixed(0)}%`}</td><td className="px-3 py-2 font-mono tabular-nums">{tire.wearPerLap == null ? m.strategy_unavailable() : `${tire.wearPerLap}%`}</td><td className="px-3 py-2 font-mono tabular-nums">{mixedCliff && tire.cliffPct != null ? `${tire.cliffPct}% · ${formatLaps(tire.toCliff)}` : formatLaps(tire.toCliff)}</td><td className="px-3 py-2 font-mono tabular-nums">{mixedDead && tire.deadPct != null ? `${tire.deadPct}% · ${formatLaps(tire.toDead)}` : formatLaps(tire.toDead)}</td></tr>)}</tbody></table></div>
        </section>

        <details className="rounded-xl border border-app-border bg-app-surface"><summary className="cursor-pointer px-4 py-3 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-accent">{m.pit_timeline_projection_evidence()}</summary><div className="space-y-2 border-t border-app-border px-4 py-3 text-sm text-app-text-muted"><p>{strategy ? `${m.pit_timeline_fuel_rate({ rate: strategyRateText(strategy.fuel) })} · ${m.strategy_eligible_laps({ count: strategy.fuel.eligibleLaps })} · ${strategy.fuel.source === "history" ? m.strategy_historical_evidence() : strategy.fuel.source === "current-stint" ? m.strategy_current_stint() : m.strategy_unavailable()}` : m.pit_timeline_evidence_unavailable()}</p>{strategy?.tires.map((rate, index) => <p key={index}>{(["FL", "FR", "RL", "RR"] as const)[index]} · {strategyRateText(rate)} · {m.strategy_eligible_laps({ count: rate.eligibleLaps })} · {rate.source === "history" ? m.strategy_historical_evidence() : rate.source === "current-stint" ? m.strategy_current_stint() : m.strategy_unavailable()}</p>)}<p>{m.pit_timeline_projection_note()}</p></div></details>
        <details className="rounded-xl border border-app-border bg-app-surface"><summary className="cursor-pointer px-4 py-3 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-accent">{m.pit_timeline_projection_history()}</summary><div className="border-t border-app-border p-4">{sessionId == null ? <p className="text-sm text-app-text-muted">{m.strategy_history_empty()}</p> : <StrategyHistory key={`${gameId}:${sessionId}`} gameId={gameId} currentSessionId={sessionId} defaultDriverKey={historyDriverKey} />}</div></details>
        <details className="rounded-xl border border-app-border bg-app-surface">
          <summary className="cursor-pointer px-4 py-3 font-semibold focus-visible:outline-2 focus-visible:outline-app-accent">{m.race_plan_title()}</summary>
          <div className="border-t border-app-border p-4"><RaceStrategyPlanner key={`${gameId}:${sessionId}`} gameId={gameId} sessionId={sessionId} carId={carId} trackId={trackId} pi={pi} /></div>
        </details>
      </div>
    </DialogContent>
  </Dialog>;
}
