import { memo, useEffect, useMemo, useState } from "react";
import type { GameId } from "@raceiq/shared/games/ids";
import type { MetricRate, StrategyEstimatesClearedMessage } from "@raceiq/shared/racing/live/strategy";
import { getGame } from "@raceiq/shared/games/registry";
import { useClearPitEstimateHistory, usePitEstimatePage, useStrategyStints } from "./stint-strategy";
import { useRaceStrategyHost } from "./host";
import { useStrategyFormat } from "./strategy-format";


export const StrategyHistory = memo(function StrategyHistory({ gameId, currentSessionId, defaultDriverKey }: { gameId: GameId; currentSessionId: number | null; defaultDriverKey: string | null }) {
  const { m, useSessions } = useRaceStrategyHost();
  const { strategyReasonText: reasonText, strategyRateText } = useStrategyFormat();
const rateText = (rate: MetricRate) => <>{strategyRateText(rate)} · {m.strategy_eligible_laps({ count: rate.eligibleLaps })} · {rate.source === "history" ? m.strategy_historical_evidence() : rate.source === "current-stint" ? m.strategy_current_stint() : m.strategy_unavailable()}{rate.provisional && ` · ${m.race_result_provisional()}`}</>;
  const sessionsQuery = useSessions({ allGames: true });
  const sessions = useMemo(() => (sessionsQuery.data ?? []).filter((session) => session.gameId === gameId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [sessionsQuery.data, gameId]);
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(currentSessionId);
  const [driverKey, setDriverKey] = useState<string | null>(defaultDriverKey);
  const [cursor, setCursor] = useState<string | null>(null);
  const selectedSessionIsAvailable = selectedSessionId == null || selectedSessionId === currentSessionId || sessions.some((session) => session.id === selectedSessionId);
  const sessionId = sessionsQuery.isSuccess && !selectedSessionIsAvailable
    ? currentSessionId ?? sessions[0]?.id ?? null
    : selectedSessionId ?? currentSessionId ?? sessions[0]?.id ?? null;
  useEffect(() => {
    setSelectedSessionId(currentSessionId);
    setCursor(null);
  }, [gameId]);
  useEffect(() => {
    setDriverKey(defaultDriverKey);
  }, [gameId, currentSessionId, defaultDriverKey]);
  useEffect(() => {
    if (sessionsQuery.isSuccess && !selectedSessionIsAvailable) setSelectedSessionId(sessionId);
  }, [sessionsQuery.isSuccess, selectedSessionIsAvailable, sessionId]);
  const stintsQuery = useStrategyStints(gameId, sessionId);
  const estimatesQuery = usePitEstimatePage(gameId, sessionId, driverKey, cursor);
  const clearMutation = useClearPitEstimateHistory(gameId, sessionId, driverKey);
  useEffect(() => {
    if (cursor != null && estimatesQuery.isError && estimatesQuery.error instanceof Error && estimatesQuery.error.message.startsWith("400")) setCursor(null);
  }, [cursor, estimatesQuery.isError, estimatesQuery.error]);
  const allDrivers = useMemo(() => [...new Set([...(driverKey ? [driverKey] : []), ...(defaultDriverKey ? [defaultDriverKey] : []), ...(stintsQuery.data?.stints.map((stint) => stint.driverKey) ?? []), ...(estimatesQuery.data?.estimates.map((estimate) => estimate.driverKey) ?? [])])], [driverKey, defaultDriverKey, stintsQuery.data, estimatesQuery.data]);
  useEffect(() => { setCursor(null); }, [gameId, sessionId, driverKey]);
  useEffect(() => {
    const onCleared = (event: Event) => {
      const message = (event as CustomEvent<StrategyEstimatesClearedMessage>).detail;
      if (message?.type === "strategy-estimates-cleared" && message.gameId === gameId && message.sessionId === sessionId && (!driverKey || message.driverKey === driverKey)) setCursor(null);
    };
    window.addEventListener("raceiq-strategy-estimates-cleared", onCleared);
    return () => window.removeEventListener("raceiq-strategy-estimates-cleared", onCleared);
  }, [gameId, sessionId, driverKey]);
  const estimates = estimatesQuery.data?.estimates ?? [];
  return <section data-testid="strategy-history" className="min-w-0 space-y-3 text-sm">
    <h3 className="font-semibold">{m.strategy_recent_estimates()}</h3>
    {sessionsQuery.isError ? <p role="alert">{m.strategy_history_error()} <button type="button" className="underline" onClick={() => void sessionsQuery.refetch()}>{m.strategy_retry()}</button></p> : sessionsQuery.isLoading ? <p role="status">{m.common_loading()}</p> : sessions.length === 0 && currentSessionId == null ? <p className="text-app-text-muted">{m.strategy_history_empty()}</p> : <>
      <label className="block">{m.review_session()}<select className="ml-2 max-w-full rounded border border-app-border bg-app-surface p-1" value={sessionId ?? ""} onChange={(event) => { setSelectedSessionId(Number(event.target.value)); setCursor(null); }}>
        {currentSessionId != null && !sessions.some((item) => item.id === currentSessionId) && <option value={currentSessionId}>{m.review_session()} {currentSessionId} · {m.strategy_current_stint()}</option>}
        {sessions.map((item) => <option key={item.id} value={item.id}>{m.review_session()} {item.id} · {new Date(item.createdAt).toLocaleString()}{item.id === currentSessionId ? ` · ${m.strategy_current_stint()}` : ""}</option>)}
      </select></label>
      <p className="text-xs text-app-text-muted">{m.review_session()} {sessionId} · {sessionId === currentSessionId ? m.strategy_current_stint() : m.strategy_previous_sessions()}</p>
      <label className="block">{m.strategy_driver({ driver: "" })}<select className="ml-2 max-w-full rounded border border-app-border bg-app-surface p-1" value={driverKey ?? ""} onChange={(event) => { setDriverKey(event.target.value || null); setCursor(null); }}><option value="">{m.browser_all()}</option>{allDrivers.map((driver) => <option key={driver} value={driver}>{driver === "local-player" ? m.strategy_local_player() : m.strategy_driver({ driver })}</option>)}</select></label>
      {stintsQuery.isError && <p role="alert">{m.strategy_history_error()} <button type="button" className="underline" onClick={() => void stintsQuery.refetch()}>{m.strategy_retry()}</button></p>}
      {estimatesQuery.isLoading ? <p role="status">{m.common_loading()}</p> : estimatesQuery.isError ? <p role="alert">{m.strategy_history_error()} <button type="button" className="underline" onClick={() => void estimatesQuery.refetch()}>{m.strategy_retry()}</button></p> : estimates.length === 0 ? <p className="text-app-text-muted">{m.strategy_history_empty()}</p> : estimates.map((item) => <article key={item.id} data-estimate-id={item.id} className="min-w-0 break-words border-l-2 border-app-border pl-2 text-xs"><details className="space-y-1">
        <summary className="cursor-pointer"><time dateTime={item.observedAt}>{new Date(item.observedAt).toLocaleString()}</time> · {item.pitInLaps == null ? m.strategy_pit_lap_unavailable() : m.strategy_pit_laps({ value: item.pitInLaps.toFixed(1) })}</summary>
        <p>{m.analyse_game_label()}: {item.gameId} · {m.analyse_car_label()}: {item.carId} · {m.analyse_track_label()}: {item.trackId} · {m.cars_pi()}: {item.pi ?? "—"}</p>
        <p>{m.label_tires()}: {item.compounds.map((compound, index) => `${["FL", "FR", "RL", "RR"][index]} ${compound ?? "—"}`).join(" · ")} · {m.strategy_evidence_link({ session: item.sessionId, stint: item.stintId })}</p>
        <p>{item.pitInLaps == null ? m.strategy_pit_lap_unavailable() : m.strategy_pit_laps({ value: item.pitInLaps.toFixed(1) })} · {item.estimatedPitTime.sessionElapsedSeconds == null ? m.strategy_pit_time_unavailable() : m.strategy_pit_time({ value: item.estimatedPitTime.sessionElapsedSeconds.toFixed(0) })}</p>
        <p>{item.limitedBy === "fuel" ? m.strategy_limited_fuel() : item.limitedBy === "tires" ? m.strategy_limited_tires() : m.strategy_no_limiter()} · {item.tyreChangeSuggestion === "consider-change" ? m.strategy_consider_tires() : item.tyreChangeSuggestion === "not-indicated" ? m.strategy_tires_not_indicated() : m.strategy_tires_unavailable()} · {item.fuelChangeSuggestion === "consider-refuel" ? m.strategy_consider_fuel() : item.fuelChangeSuggestion === "not-indicated" ? m.strategy_fuel_not_indicated() : m.strategy_fuel_unavailable()}</p>
        <p>{m.strategy_historical_evidence()} · {m.strategy_last_observed({ time: item.baseline?.lastObservedAt ? new Date(item.baseline.lastObservedAt).toLocaleString() : m.strategy_unknown() })}</p>
        {(["fuel", "fl", "fr", "rl", "rr"] as const).map((metric, index) => {
          const evidence = item.baseline?.evidence.filter((entry) => entry.metric === metric) ?? [];
          const rate = index === 0 ? item.baseline?.fuel : item.baseline?.tires[index - 1];
          return <p key={metric}>{metric === "fuel" ? m.label_fuel() : metric.toUpperCase()} · {rate ? strategyRateText(rate) : m.strategy_unavailable()} · {m.strategy_evidence_counts({ sessions: new Set(evidence.map((entry) => entry.sessionId)).size, stints: new Set(evidence.map((entry) => entry.stintId)).size, laps: evidence.reduce((sum, entry) => sum + entry.eligibleLaps, 0) })} {evidence.map((entry) => <a key={`${entry.sessionId}:${entry.stintId}`} className="ml-2 underline" href={`/${getGame(item.gameId).routePrefix}/sessions/${entry.sessionId}/analyse#stint-${encodeURIComponent(entry.stintId)}`}>{m.strategy_evidence_link({ session: entry.sessionId, stint: entry.stintId })}</a>)}</p>;
        })}
        {item.baseline?.limitations.map((limitation, index) => <p key={index}>{reasonText(limitation)}</p>)}
        <p>{m.strategy_fuel_rate()}: {rateText(item.fuel)}</p>
        {item.tires.map((rate, index) => <p key={index}>{["FL", "FR", "RL", "RR"][index]}: {rateText(rate)}</p>)}
        <p>{m.strategy_setup()}: {item.compatibility.setupKey == null || item.compatibility.setupKey === "unknown-setup-key" ? m.strategy_setup_uncertain() : item.compatibility.setupKey} · {item.algorithmVersion}</p>
        <p>{m.strategy_fuel_semantics()}: {item.compatibility.fuelSemanticVersion ?? m.strategy_unknown()} · {m.strategy_tire_semantics()}: {item.compatibility.tireSemanticVersions.map((value) => value ?? m.strategy_unknown()).join(" · ")}</p>
        <p>{m.strategy_conditions()}: {item.compatibility.conditions.weather ?? m.strategy_unknown()} · {item.compatibility.conditions.airTemperatureC ?? m.strategy_unknown()} · {item.compatibility.conditions.trackTemperatureC ?? m.strategy_unknown()}</p>
      </details></article>)}
      <div className="flex flex-wrap gap-3">
        {cursor && <button type="button" className="underline" onClick={() => setCursor(null)}>{m.strategy_recent_estimates()}</button>}
        {estimatesQuery.data?.nextCursor && <button type="button" className="underline" onClick={() => setCursor(estimatesQuery.data!.nextCursor)}>{m.strategy_older_estimates()}</button>}
        {driverKey && <button type="button" className="underline" disabled={clearMutation.isPending} onClick={() => { const driver = driverKey === "local-player" ? m.strategy_local_player() : driverKey; if (window.confirm(m.strategy_clear_confirm({ driver, session: String(sessionId) }))) clearMutation.mutate(undefined, { onSuccess: () => { setCursor(null); void estimatesQuery.refetch(); } }); }}>{clearMutation.isPending ? m.strategy_clearing() : m.strategy_clear()}</button>}
      </div>
      {clearMutation.isError && <p role="alert">{m.strategy_clear_error()}</p>}
    </>}
  </section>;
});
