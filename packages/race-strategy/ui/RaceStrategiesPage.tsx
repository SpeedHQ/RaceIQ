import { useState } from "react";
import type { GameId } from "@raceiq/shared/games/ids";
import { estimateRaceLaps, type RacePlan, type RacePlanInput } from "@raceiq/shared/racing/live/race-plan";
import { getTireThresholds } from "@raceiq/shared/racing/live/tire-thresholds";
import { useRaceStrategyHost } from "./host";
import { useActiveRacePlan, useDeleteRacePlan, useRacePlans, useSetActiveRacePlan } from "./race-plans";
import { useStrategyStints } from "./stint-strategy";
import { RaceStrategyPlanner } from "./RaceStrategyPlanner";
import { generateRacePlanStints } from "./generate-race-plan";

function StrategyGenerator({ gameId, sessionId, onGenerate }: {
  gameId: GameId; sessionId?: number; onGenerate: (input: RacePlanInput) => void;
}) {
  const { m, useSessions, useSettings, Button } = useRaceStrategyHost();
  const sessions = useSessions({ allGames: true });
  const ownSessions = (sessions.data ?? []).filter((session) => session.gameId === gameId && session.ownership === "mine");
  const [selectedSession, setSelectedSession] = useState<number | null>(sessionId ?? null);
  const stints = useStrategyStints(gameId, selectedSession);
  const [sourceId, setSourceId] = useState("");
  const sources = (stints.data?.stints ?? []).filter((stint) => stint.driverKey === "local-player" && stint.status !== "active");
  const source = sourceId ? sources.find((stint) => stint.id === sourceId) : sources.find((stint) => stint.fuel.value != null && stint.fuel.eligibleLaps > 0);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"laps" | "time">("laps");
  const [laps, setLaps] = useState(20);
  const [minutes, setMinutes] = useState(60);
  const [capacity, setCapacity] = useState("");
  const [reserve, setReserve] = useState("0");
  const [error, setError] = useState(false);
  const { displaySettings } = useSettings();
  const fractional = source?.fuelUnit === "tankFraction";
  const totalLaps = mode === "time" ? estimateRaceLaps(minutes * 60, source?.averageLapSeconds ?? 0) : laps;
  const generate = () => {
    if (!source || !ownSessions.some((session) => session.id === selectedSession) || !name.trim() || name.trim().length > 120 ||
        totalLaps == null || !capacity.trim() || !reserve.trim()) { setError(true); return; }
    const factor = fractional ? 100 : 1;
    const generated = generateRacePlanStints(source, totalLaps, Number(capacity) / factor, Number(reserve) / factor,
      (compound) => getTireThresholds(displaySettings.tireThresholdOverrides ?? {}, gameId, compound));
    if (!generated || gameId === "fm-2023" && source.pi == null) { setError(true); return; }
    onGenerate({ name: name.trim(), gameId, carId: source.carId, trackId: source.trackId, pi: source.pi, totalLaps,
      raceLength: mode === "time" ? { mode: "time", durationSeconds: minutes * 60, averageLapSeconds: source.averageLapSeconds! } : { mode: "laps" },
      fuelUnit: source.fuelUnit, notes: "", stints: generated });
  };
  const input = "mt-1 w-full min-w-0 rounded border border-app-border bg-app-bg px-3 py-2";
  return <section data-testid="race-strategy-generator" className="space-y-4 rounded-lg border border-app-border bg-app-surface p-4">
    <h2 className="font-semibold">{m.race_plan_generate()}</h2>
    <p className="max-w-prose text-sm text-app-text-muted">{m.race_plan_generate_help()}</p>
    {sessions.isError && <p role="alert">{m.race_plan_sources_error()} <button type="button" onClick={() => void sessions.refetch()}>{m.strategy_retry()}</button></p>}
    {stints.isError && <p role="alert">{m.strategy_stints_error()} <button type="button" onClick={() => void stints.refetch()}>{m.strategy_retry()}</button></p>}
    <form onSubmit={(event) => { event.preventDefault(); generate(); }} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-sm">{m.race_plan_name()}<input required maxLength={120} className={input} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="text-sm">{m.race_plan_source_session()}<select required className={input} value={selectedSession ?? ""} onChange={(event) => { setSelectedSession(Number(event.target.value) || null); setSourceId(""); setCapacity(""); setError(false); }}><option value="">{m.race_plan_manual_source()}</option>{ownSessions.map((session) => <option key={session.id} value={session.id}>{m.review_session()} {session.id} · {session.carId} / {session.trackId}</option>)}</select></label>
        <label className="text-sm">{m.race_plan_evidence()}<select required className={input} value={source?.id ?? ""} onChange={(event) => { setSourceId(event.target.value); setCapacity(""); setError(false); }}><option value="">{m.race_plan_source_unavailable()}</option>{sources.map((stint) => <option key={stint.id} value={stint.id}>{m.strategy_stint({ ordinal: stint.ordinal })} · {m.strategy_eligible_laps({ count: stint.fuel.eligibleLaps })}</option>)}</select></label>
        <label className="text-sm">{m.race_plan_length_mode()}<select aria-label={m.race_plan_length_mode()} className={input} value={mode} onChange={(event) => setMode(event.target.value as "laps" | "time")}><option value="laps">{m.label_laps()}</option><option value="time">{m.race_plan_time()}</option></select></label>
        {mode === "laps" ? <label className="text-sm">{m.race_plan_total_laps()}<input required className={input} type="number" min={1} max={10000} step={1} value={laps} onChange={(event) => setLaps(Number(event.target.value))} /></label> : <label className="text-sm">{m.race_plan_duration_minutes()}<input required className={input} type="number" min={0.01} max={10080} step="any" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label>}
        <label className="text-sm">{m.race_plan_capacity()} ({fractional ? "%" : "L"})<input required className={input} type="number" min={0.001} max={fractional ? 100 : undefined} step="any" value={capacity} onChange={(event) => setCapacity(event.target.value)} /></label>
        <label className="text-sm">{m.race_plan_reserve()} ({fractional ? "%" : "L"})<input required className={input} type="number" min={0} max={fractional ? 100 : undefined} step="any" value={reserve} onChange={(event) => setReserve(event.target.value)} /></label>
      </div>
      {mode === "time" && <p role="status" className="text-sm">{totalLaps == null ? m.race_plan_time_unavailable() : m.race_plan_time_estimate({ laps: totalLaps, seconds: source!.averageLapSeconds!.toFixed(2) })}</p>}
      {error && <p role="alert" className="text-sm text-status-danger">{m.race_plan_generate_error()}</p>}
      <Button variant="app-primary" type="submit" disabled={sessions.isLoading || stints.isFetching}>{m.race_plan_generate()}</Button>
    </form>
  </section>;
}

export function RaceStrategiesPage({ gameId, sessionId }: { gameId: GameId; sessionId?: number }) {
  const { m, Button } = useRaceStrategyHost();
  const plans = useRacePlans(gameId);
  const active = useActiveRacePlan();
  const activate = useSetActiveRacePlan();
  const remove = useDeleteRacePlan(gameId);
  const [generating, setGenerating] = useState(sessionId != null);
  const [editing, setEditing] = useState<{ plan?: RacePlan; draft?: RacePlanInput } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return <section className="min-w-0 space-y-4" data-testid="race-strategies-page">
    <header className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold">{m.race_plan_strategies()}</h1>{!editing && <div className="flex flex-wrap gap-2">
      <Button variant="app-outline" onClick={() => { setEditing({}); setGenerating(false); }}>{m.race_plan_new()}</Button>
      <Button variant="app-primary" onClick={() => { setGenerating(true); setEditing(null); }}>{m.race_plan_generate()}</Button>
    </div>}</header>
    {editing && <><Button variant="app-outline" disabled={saving} onClick={() => setEditing(null)}>{m.race_plan_strategies()}</Button><RaceStrategyPlanner key={editing.plan?.id ?? "new"} gameId={gameId} sessionId={sessionId} initialPlan={editing.plan} initialDraft={editing.draft} onSavingChange={setSaving} /></>}
    {!editing && generating && <StrategyGenerator gameId={gameId} sessionId={sessionId} onGenerate={(draft) => { setEditing({ draft }); setGenerating(false); }} />}
    {!editing && <section aria-label={m.race_plan_saved()} className="space-y-3">
      {plans.isLoading && <p role="status">{m.common_loading()}</p>}
      {plans.isError && <p role="alert">{m.race_plan_load_error()} <button type="button" className="underline" onClick={() => void plans.refetch()}>{m.strategy_retry()}</button></p>}
      {active.isError && <p role="alert">{m.race_plan_live_error()} <button type="button" className="underline" onClick={() => void active.refetch()}>{m.strategy_retry()}</button></p>}
      {!plans.isLoading && !plans.isError && plans.data?.plans.length === 0 && <p className="rounded-lg border border-app-border p-6 text-app-text-muted">{m.race_plan_empty()}</p>}
      {error && <p role="alert" className="text-status-danger">{error}</p>}
      {(plans.data?.plans ?? []).length > 0 && <div role="region" aria-label={m.race_plan_saved()} tabIndex={0} className="overflow-x-auto rounded-lg border border-app-border"><table className="w-full min-w-[40rem] text-left text-sm" data-testid="saved-strategies-table">
        <caption className="sr-only">{m.race_plan_saved()}</caption>
        <thead className="border-b border-app-border text-app-text-muted"><tr>{[m.race_plan_name(), m.analyse_car_label(), m.analyse_track_label(), m.race_plan_total_laps(), m.race_plan_stints(), m.race_plan_manage()].map((label) => <th key={label} scope="col" className="p-3">{label}</th>)}</tr></thead>
        <tbody>{(plans.data?.plans ?? []).map((plan) => <tr key={plan.id} className="border-b border-app-border last:border-0">
          <th scope="row" className="p-3"><button type="button" className="text-left underline" onClick={() => { setEditing({ plan }); setGenerating(false); }}>{plan.name}</button>{active.data?.plan?.id === plan.id && <span className="block text-xs text-app-accent">{m.race_plan_loaded()}</span>}</th>
          <td className="p-3">{plan.carId}</td><td className="p-3">{plan.trackId}</td><td className="p-3">{plan.totalLaps}</td><td className="p-3">{plan.stints.length}</td>
          <td className="p-3"><div className="flex gap-2"><Button variant="app-outline" disabled={activate.isPending || active.isError} onClick={() => { setError(null); activate.mutate(active.data?.plan?.id === plan.id ? null : plan.id, { onError: () => setError(m.race_plan_load_error()) }); }}>{active.data?.plan?.id === plan.id ? m.race_plan_unload() : m.race_plan_load()}</Button><Button variant="app-outline" disabled={remove.isPending} onClick={() => { setError(null); remove.mutate(plan.id, { onError: () => setError(m.race_plan_delete_error()) }); }}>{m.race_plan_delete()}</Button></div></td>
        </tr>)}</tbody>
      </table></div>}
    </section>}
  </section>;
}
