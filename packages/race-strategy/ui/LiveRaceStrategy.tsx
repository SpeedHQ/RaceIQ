import { Link } from "@tanstack/react-router";
import { supportsRaceRefueling } from "../contracts/race-rules";
import type { GameId } from "@raceiq/shared/games/ids";
import { getGame } from "@raceiq/shared/games/registry";
import { useActiveRacePlans } from "./race-plans";
import { useRaceStrategyHost } from "./host";
import type { RacePlan } from "@raceiq/shared/racing/live/race-plan";
import { getTireThresholds } from "@raceiq/shared/racing/live/tire-thresholds";
import { isRacePlanApplicable, projectRacePlanStint, racePlanProgress } from "./race-plan-projection";

export function LiveRaceStrategy({ gameId, carId, trackId, pi, currentLap, onManage }: { gameId: GameId; carId: string | null; trackId: string | null; pi: number | null; currentLap: number | null; onManage?: () => void }) {
  const { m } = useRaceStrategyHost();
  const query = useActiveRacePlans();
  const selected = query.data?.plans.find((item) => item.gameId === gameId && carId != null && item.carId === carId && trackId != null && item.trackId === trackId) ?? null;
  const plan = selected;
  const applicable = isRacePlanApplicable(plan, { gameId, carId, trackId, pi });
  const { currentStint, finished } = plan ? racePlanProgress(plan, currentLap) : { currentStint: null, finished: false };
  const baseline = currentStint?.baseline;
  return <section data-testid="live-race-strategy" className="min-w-0 space-y-2 rounded-xl border border-app-border bg-app-surface p-3" aria-labelledby="live-race-strategy-title">
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h2 id="live-race-strategy-title" className="text-sm font-semibold">{m.race_plan_live_title()}</h2>{query.isLoading ? <p role="status" className="text-sm text-app-text-muted">{m.common_loading()}</p> : query.isError ? <p role="alert" className="text-sm text-status-danger">{m.race_plan_live_error()} <button type="button" className="underline" onClick={() => void query.refetch()}>{m.strategy_retry()}</button></p> : !plan ? <p className="text-sm text-app-text-muted">{m.race_plan_none_loaded()}</p> : <div className="min-w-0 break-words text-sm"><p className="font-medium">{plan.name}</p>{!applicable ? <p role="status" className="text-status-warning">{m.race_plan_mismatch()}</p> : finished ? <p role="status" className="text-app-text-muted">{m.race_plan_complete()}</p> : currentStint == null ? <p role="status" className="text-app-text-muted">{m.race_plan_lap_unavailable()}</p> : <><p>{m.race_plan_current_stint({ ordinal: plan.stints.indexOf(currentStint) + 1, endLap: currentStint.endLap })}</p>{currentStint.endLap === plan.totalLaps ? <p>{m.race_plan_finish_no_stop()}</p> : <p>{m.race_plan_next_stop({ lap: currentStint.endLap, remaining: Math.max(0, currentStint.endLap - currentLap!) })}</p>}<p>{m.race_plan_live_fuel({ fuel: currentStint.startFuel == null ? m.strategy_unavailable() : plan.fuelUnit === "tankFraction" ? `${(currentStint.startFuel * 100).toFixed(1)}%` : `${currentStint.startFuel.toFixed(1)} L`, compounds: currentStint.compounds.map((compound, index) => `${["FL", "FR", "RL", "RR"][index]} ${compound ?? m.strategy_unknown()}`).join(" · ") })}</p>{currentStint.evidence && <Link className="block text-xs text-app-text-muted underline" to="/$gameid/sessions/$sessionId/analyse" params={{ gameid: getGame(plan.gameId).routePrefix, sessionId: String(currentStint.evidence.sessionId) }} hash={`stint-${encodeURIComponent(currentStint.evidence.id)}`}>{m.race_plan_live_source({ session: currentStint.sourceSessionId ?? currentStint.evidence.sessionId, stint: currentStint.evidence.ordinal, laps: currentStint.evidence.completedLaps })}</Link>}</>}</div>}</div>{onManage && <button type="button" className="shrink-0 rounded border border-app-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-app-accent" onClick={onManage}>{m.race_plan_manage()}</button>}</div>
    {baseline && <ul aria-label={m.race_plan_sources_label()} className="flex flex-wrap gap-x-3 text-xs text-app-text-muted">
      {baseline.sources.map((source) => <li key={`${source.sessionId}:${source.id}`}><Link className="underline" to="/$gameid/sessions/$sessionId/analyse" params={{ gameid: getGame(gameId).routePrefix, sessionId: String(source.sessionId) }} hash={`stint-${encodeURIComponent(source.id)}`}>{m.review_session()} {source.sessionId} · {new Date(source.endedAt ?? source.startedAt).toLocaleDateString()}</Link></li>)}
    </ul>}
  </section>;
}

export function CompactRaceStrategy({ plan, currentLap }: { plan: RacePlan; currentLap: number | null }) {
  const { m, useSettings } = useRaceStrategyHost();
  const { displaySettings } = useSettings();
  const { index, currentStint, nextStint, finished } = racePlanProgress(plan, currentLap);
  const forecast = currentStint ? projectRacePlanStint(
    currentStint, plan.stints[index - 1]?.endLap ?? 0, plan, currentStint.baseline ?? currentStint.evidence,
    (compound) => getTireThresholds(displaySettings.tireThresholdOverrides ?? {}, plan.gameId, compound),
  ) : null;
  const fuelText = (value: number | null) => value == null ? m.strategy_unavailable() : plan.fuelUnit === "tankFraction" ? `${(value * 100).toFixed(1)}%` : `${value.toFixed(1)} L`;
  const dead = forecast?.tires.some((tire) => tire.health != null && tire.health <= tire.deadPct);
  const cliff = forecast?.tires.some((tire) => tire.health != null && tire.health <= tire.cliffPct);
  return <div data-testid="race-strategy-summary" className="min-w-0 space-y-2 break-words">
    <p className="font-semibold">{plan.name}</p>
    {finished ? <p role="status">{m.race_plan_complete()}</p> : !currentStint || !forecast ? <p role="status">{m.race_plan_lap_unavailable()}</p> : <>
      <p className="text-xs text-app-text-muted">{m.race_plan_current_stint({ ordinal: index + 1, endLap: currentStint.endLap })}</p>
      {(nextStint || supportsRaceRefueling(plan.gameId)) && <p className="font-semibold tabular-nums">{nextStint ? m.race_plan_next_stop({ lap: currentStint.endLap, remaining: Math.max(0, currentStint.endLap - currentLap!) }) : m.race_plan_finish_no_stop()}</p>}
      {supportsRaceRefueling(plan.gameId) && <><p className="text-xs text-app-text-secondary">{m.race_plan_required_fuel({ value: fuelText(forecast.consumed) })}</p>
      {forecast.fuelWarning && <p role="status" className="text-xs text-status-danger">{m.race_plan_fuel_short()}</p>}</>}
      <table className="w-full table-fixed text-xs">
        <caption className="pb-1 text-left text-app-text-muted">{m.race_plan_fresh_tires()}</caption>
        <thead className="text-app-text-muted"><tr className="border-b border-app-border">
          <th scope="col" className="w-10 py-1 text-left font-normal">{m.pit_timeline_corner()}</th>
          <th scope="col" className="py-1 text-left font-normal">{m.accsetup_compound()}</th>
          <th scope="col" className="py-1 text-right font-normal">{m.pit_cliff()}<span className="block">{m.pitwindow_laps()}</span></th>
          <th scope="col" className="py-1 text-right font-normal">{m.pit_dead()}<span className="block">{m.pitwindow_laps()}</span></th>
        </tr></thead>
        <tbody className="tabular-nums">{forecast.tires.map((tire, wheel) => <tr key={wheel} data-testid="race-strategy-tire-life" className="border-b border-app-border/50 last:border-0">
          <th scope="row" className="py-1 text-left">{["FL", "FR", "RL", "RR"][wheel]}</th>
          <td className="py-1">{currentStint.compounds[wheel] ?? m.strategy_unknown()}</td>
          {tire.zeroWear || tire.cliffLaps == null || tire.deadLaps == null ? <td colSpan={2} className="py-1 text-right text-app-text-muted">{tire.zeroWear ? m.race_plan_tire_no_wear() : m.strategy_unavailable()}</td> : <>
            <td className="py-1 text-right">{tire.cliffLaps.toFixed(1)}<span className="block text-app-text-dim">{tire.cliffPct}%</span></td>
            <td className="py-1 text-right">{tire.deadLaps.toFixed(1)}<span className="block text-app-text-dim">{tire.deadPct}%</span></td>
          </>}
        </tr>)}</tbody>
      </table>
      {(dead || cliff) && <p role="status" className={`text-xs ${dead ? "text-status-danger" : "text-status-warning"}`}>{m.label_tires()}: {dead ? m.race_plan_dead_warning() : m.race_plan_cliff_warning()}</p>}
      {nextStint && <div data-testid="race-strategy-next-stint" className="border-t border-app-border pt-2 text-xs text-app-text-secondary">
        <p className="font-semibold">{m.race_plan_stint({ ordinal: index + 2 })}</p>
        {supportsRaceRefueling(plan.gameId) ? <p>{m.race_plan_live_fuel({ fuel: fuelText(nextStint.startFuel), compounds: nextStint.compounds.map((compound, wheel) => `${["FL", "FR", "RL", "RR"][wheel]} ${compound ?? m.strategy_unknown()}`).join(" · ") })}</p> : <p>{nextStint.compounds.map((compound, wheel) => `${["FL", "FR", "RL", "RR"][wheel]} ${compound ?? m.strategy_unknown()}`).join(" · ")}</p>}
      </div>}
    </>}
  </div>;
}
