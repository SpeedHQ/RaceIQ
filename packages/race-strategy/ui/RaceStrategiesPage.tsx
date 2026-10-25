import { Link } from "@tanstack/react-router";
import { getGame } from "@raceiq/shared/games/registry";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GameId } from "@raceiq/shared/games/ids";
import { estimateRaceLaps, RacePlanGenerationEvidenceResponseSchema, RacePlanGenerationSchema, type RacePlan, type RacePlanBaseline, type RacePlanGeneration, type RacePlanInput, type RacePlanWeather } from "@raceiq/shared/racing/live/race-plan";
import { generateRacePlanStints } from "../contracts/generate-race-plan";
import type { StintSummary } from "@raceiq/shared/racing/live/strategy";
import { getTireThresholds } from "@raceiq/shared/racing/live/tire-thresholds";
import { useRaceStrategyHost } from "./host";
import { useActiveRacePlans, useDeleteRacePlan, useRacePlans, useRecalculateRacePlan, useSetActiveRacePlan } from "./race-plans";
import { RaceStrategyPlanner } from "./RaceStrategyPlanner";
import { aggregateRacePlanEvidence } from "@raceiq/shared/racing/live/race-plan-evidence";
import { supportsRaceRefueling } from "../contracts/race-rules";
import { useStrategyFormat } from "./strategy-format";

const fieldClass = "mt-1 w-full bg-app-surface-alt text-app-detail";

function ResourceFields({ gameId, fractional, energy, capacity, reserve, energyReserve, onCapacity, onReserve, onEnergyReserve, disabled }: {
  gameId: GameId; fractional: boolean; energy: boolean; capacity: string; reserve: string; energyReserve: string;
  onCapacity(value: string): void; onReserve(value: string): void; onEnergyReserve(value: string): void; disabled?: boolean;
}) {
  const { m, Input } = useRaceStrategyHost();
  return <>
    <label className="min-w-0 text-app-detail">{supportsRaceRefueling(gameId) ? m.race_plan_capacity() : m.race_plan_start_fuel()} ({fractional ? "%" : "L"})<Input required className={fieldClass} type="number" min={0.001} max={fractional ? 100 : undefined} step="any" value={capacity} disabled={disabled} onChange={(event) => onCapacity(event.target.value)} /></label>
    <label className="min-w-0 text-app-detail">{supportsRaceRefueling(gameId) ? m.race_plan_reserve() : m.race_plan_finish_reserve()} ({fractional ? "%" : "L"})<Input required className={fieldClass} type="number" min={0} max={fractional ? 100 : undefined} step="any" value={reserve} disabled={disabled} onChange={(event) => onReserve(event.target.value)} /></label>
    {energy && <label className="min-w-0 text-app-detail">{m.race_plan_energy_reserve()} (%)<Input required className={fieldClass} type="number" min={0} max={99.99} step="any" value={energyReserve} disabled={disabled} onChange={(event) => onEnergyReserve(event.target.value)} /></label>}
  </>;
}

function parseConstraints(fractional: boolean, capacity: string, reserve: string, energyReserve: string): RacePlanGeneration | null {
  if (!capacity.trim() || !reserve.trim() || !energyReserve.trim()) return null;
  const factor = fractional ? 100 : 1;
  const parsed = RacePlanGenerationSchema.safeParse({ fuelCapacity: Number(capacity) / factor, fuelReserve: Number(reserve) / factor, energyReserveFraction: Number(energyReserve) / 100 });
  return parsed.success && (!fractional || parsed.data.fuelCapacity <= 1) ? parsed.data : null;
}

function StrategyGenerator({ gameId, onGenerate, onManual }: { gameId: GameId; onGenerate(input: RacePlanInput, baseline: RacePlanBaseline): void; onManual(): void }) {
  const { m, api, useSessions, useTracksForGame, useCarsForGame, useSettings, Button, Input, Select } = useRaceStrategyHost();
  const { strategyRateText } = useStrategyFormat();
  const sessions = useSessions({ allGames: true });
  const trackCatalog = useTracksForGame(gameId);
  const carCatalog = useCarsForGame(gameId);
  const ownSessions = (sessions.data ?? []).filter((session) => session.gameId === gameId && session.ownership === "mine")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  const tracks = [...new Set([...(trackCatalog.data ?? []).map(({ id }) => id), ...ownSessions.map((session) => session.trackId)])];
  const cars = [...new Set([...(carCatalog.data ?? []).map(({ id }) => id), ...ownSessions.map((session) => session.carId)])];
  const game = getGame(gameId);
  const trackName = (id: string) => {
    const track = trackCatalog.data?.find((candidate) => candidate.id === id);
    return track ? `${track.name}${track.variant ? ` · ${track.variant}` : ""}` : game.getTrackName(id);
  };
  const trackNames = tracks.map(trackName);
  const carNames = cars.map((id) => carCatalog.data?.find((car) => car.id === id)?.name ?? game.getCarName(id));
  const trackLabel = (id: string) => {
    const name = trackName(id);
    return name === id ? id : trackNames.filter((candidate) => candidate === name).length > 1 ? `${name} (${id})` : name;
  };
  const carLabel = (id: string) => {
    const name = carCatalog.data?.find((car) => car.id === id)?.name ?? game.getCarName(id);
    return name === id ? id : carNames.filter((candidate) => candidate === name).length > 1 ? `${name} (${id})` : name;
  };
  const latest = ownSessions[0];
  const [trackId, setTrackId] = useState("");
  const [carId, setCarId] = useState("");
  const [weather, setWeather] = useState<RacePlanWeather>("any");
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (!initialized && latest) { setTrackId(latest.trackId); setCarId(latest.carId); setInitialized(true); }
  }, [initialized, latest]);
  const { displaySettings } = useSettings();
  const evidence = useQuery({
    queryKey: ["race-plan-generation-evidence", gameId, trackId, carId, weather],
    enabled: !!trackId && !!carId,
    queryFn: async ({ signal }) => RacePlanGenerationEvidenceResponseSchema.parse(await api.generationEvidence(gameId, carId, trackId, weather, signal)),
    refetchOnMount: "always",
  });
  const source = evidence.data?.baseline ?? null;
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"laps" | "time">("laps");
  const [laps, setLaps] = useState(20);
  const [minutes, setMinutes] = useState(60);
  const [capacity, setCapacity] = useState("");
  const [reserve, setReserve] = useState("0");
  const [energyReserve, setEnergyReserve] = useState("0");
  const [error, setError] = useState(false);
  const fractional = source?.fuelUnit === "tankFraction";
  const totalLaps = mode === "time" ? estimateRaceLaps(minutes * 60, source?.averageLapSeconds ?? 0) : laps;
  const resetConditions = (patch: { trackId?: string; carId?: string; weather?: RacePlanWeather }) => {
    setInitialized(true);
    if (patch.trackId !== undefined) setTrackId(patch.trackId);
    if (patch.carId !== undefined) setCarId(patch.carId);
    if (patch.weather !== undefined) setWeather(patch.weather);
    setCapacity(""); setError(false);
  };
  const generate = () => {
    const generation = parseConstraints(fractional, capacity, reserve, energyReserve);
    if (!source || !name.trim() || name.trim().length > 120 || totalLaps == null || !generation) { setError(true); return; }
    const generated = generateRacePlanStints(source, totalLaps, generation.fuelCapacity, generation.fuelReserve,
      (compound) => getTireThresholds(displaySettings.tireThresholdOverrides ?? {}, gameId, compound), generation.energyReserveFraction);
    if (!generated) { setError(true); return; }
    onGenerate({ name: name.trim(), gameId, carId: source.carId, trackId: source.trackId, pi: source.pi, totalLaps,
      raceLength: mode === "time" ? { mode: "time", durationSeconds: minutes * 60, averageLapSeconds: source.averageLapSeconds! } : { mode: "laps" },
      fuelUnit: source.fuelUnit, weather, notes: "", generation, stints: generated }, source);
  };
  const catalogsLoading = trackCatalog.isPending || carCatalog.isPending;
  const loading = catalogsLoading || sessions.isLoading || (!!trackId && !!carId && (evidence.isPending || evidence.isFetching));
  return <section data-testid="race-strategy-generator" className="space-y-3 rounded border border-app-border bg-app-surface p-4">
    <h2 className="text-app-heading font-semibold">{m.race_plan_generate()}</h2>
    <p className="max-w-prose text-app-subtext text-app-text-muted">{m.race_plan_generate_help()}</p>
    {gameId === "lmu" && <p className="max-w-prose text-app-detail text-app-text-muted">{m.race_plan_energy_assumption()}</p>}
    {sessions.isError && <p role="alert">{m.race_plan_sources_error()} <Button variant="app-ghost" onClick={() => void sessions.refetch()}>{m.strategy_retry()}</Button></p>}
    {trackCatalog.isError && <p role="alert">{m.race_plan_catalogue_error()} <Button variant="app-ghost" onClick={() => void trackCatalog.refetch()}>{m.strategy_retry()}</Button></p>}
    {carCatalog.isError && <p role="alert">{m.race_plan_catalogue_error()} <Button variant="app-ghost" onClick={() => void carCatalog.refetch()}>{m.strategy_retry()}</Button></p>}
    {evidence.isError && <p role="alert">{m.strategy_stints_error()} <Button variant="app-ghost" onClick={() => void evidence.refetch()}>{m.strategy_retry()}</Button></p>}
    <form onSubmit={(event) => { event.preventDefault(); generate(); }} className="space-y-3">
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="min-w-0 text-app-detail">{m.race_plan_name()}<Input required maxLength={120} className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="min-w-0 text-app-detail">{m.analyse_track_label()}<Select aria-label={m.analyse_track_label()} className={fieldClass} value={trackId} onChange={(event) => resetConditions({ trackId: event.target.value })}><option value="">{m.race_plan_select_track()}</option>{tracks.map((track) => <option key={track} value={track}>{trackLabel(track)}</option>)}</Select></label>
        <label className="min-w-0 text-app-detail">{m.analyse_car_label()}<Select aria-label={m.analyse_car_label()} className={fieldClass} value={carId} onChange={(event) => resetConditions({ carId: event.target.value })}><option value="">{m.race_plan_select_car()}</option>{cars.map((car) => <option key={car} value={car}>{carLabel(car)}</option>)}</Select></label>
        <label className="min-w-0 text-app-detail">{m.race_plan_weather()}<Select aria-label={m.race_plan_weather()} className={fieldClass} value={weather} onChange={(event) => resetConditions({ weather: event.target.value as RacePlanWeather })}><option value="any">{m.race_plan_weather_any()}</option><option value="dry">{m.race_plan_weather_dry()}</option><option value="wet">{m.race_plan_weather_wet()}</option></Select></label>
        <label className="min-w-0 text-app-detail">{m.race_plan_length_mode()}<Select aria-label={m.race_plan_length_mode()} className={fieldClass} value={mode} onChange={(event) => setMode(event.target.value as "laps" | "time")}><option value="laps">{m.label_laps()}</option><option value="time">{m.race_plan_time()}</option></Select></label>
        {mode === "laps" ? <label className="min-w-0 text-app-detail">{m.race_plan_total_laps()}<Input required className={fieldClass} type="number" min={1} max={10000} step={1} value={laps} onChange={(event) => setLaps(Number(event.target.value))} /></label> : <label className="min-w-0 text-app-detail">{m.race_plan_duration_minutes()}<Input required className={fieldClass} type="number" min={0.01} max={10080} step="any" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label>}
        <ResourceFields gameId={gameId} fractional={fractional} energy={gameId === "lmu"} capacity={capacity} reserve={reserve} energyReserve={energyReserve} onCapacity={setCapacity} onReserve={setReserve} onEnergyReserve={setEnergyReserve} disabled={!source} />
      </div>
      {weather === "any" && source?.weather === "unknown" && <p role="status">{m.race_plan_weather_unknown()}</p>}
      {weather === "any" && source && source.weather !== "unknown" && <p role="status">{m.race_plan_weather()}: {source.weather === "dry" ? m.race_plan_weather_dry() : m.race_plan_weather_wet()}</p>}
      {loading && <p role="status">{m.common_loading()}</p>}
      {!loading && trackId && carId && !source && !evidence.isError && <div className="flex flex-wrap items-center gap-3"><p role="status" className="text-app-detail text-app-text-muted">{m.race_plan_generator_no_evidence()}</p><Button type="button" variant="app-outline" onClick={onManual}>{m.race_plan_manual_source()}</Button></div>}
      {source && <div className="text-app-detail text-app-text-muted" data-testid="generation-evidence">
        <p>{source.carId} / {source.trackId} · {m.race_plan_sources_count({ count: new Set(source.sources.map((item) => item.sessionId)).size })}</p>
        <p>{m.strategy_fuel_rate()} · {strategyRateText(source.fuel)} · {m.strategy_eligible_laps({ count: source.fuel.eligibleLaps })}</p>
        {source.tires.map((rate, index) => <p key={index}>{["FL", "FR", "RL", "RR"][index]} · {strategyRateText(rate)} · {m.strategy_eligible_laps({ count: rate.eligibleLaps })} · {source.compounds[index] ?? m.strategy_unavailable()}</p>)}
        {gameId === "lmu" && <p>{m.race_plan_energy_rate({ value: source.virtualEnergy?.value == null ? m.strategy_unavailable() : (source.virtualEnergy.value * 100).toFixed(2) })}</p>}
        <ul aria-label={m.race_plan_sources_label()}>{source.sources.map((item) => <li key={`${item.sessionId}:${item.id}`}><Link className="underline" to="/$gameid/sessions/$sessionId/analyse" params={{ gameid: getGame(gameId).routePrefix, sessionId: String(item.sessionId) }} hash={`stint-${encodeURIComponent(item.id)}`}>{m.review_session()} {item.sessionId} · {new Date(item.endedAt ?? item.startedAt).toLocaleDateString()} · {m.strategy_eligible_laps({ count: item.fuel.eligibleLaps })}</Link></li>)}</ul>
      </div>}
      {mode === "time" && <p role="status" className="text-app-detail tabular-nums">{totalLaps == null ? m.race_plan_time_unavailable() : m.race_plan_time_estimate({ laps: totalLaps, seconds: source!.averageLapSeconds!.toFixed(2) })}</p>}
      {error && <p role="alert" className="text-app-detail text-status-danger">{m.race_plan_generate_error()}</p>}
      <Button variant="app-primary" type="submit" disabled={loading || !source || sessions.isError || evidence.isError || !totalLaps}>{m.race_plan_generate()}</Button>
    </form>
  </section>;
}


function StrategyRecalculator({ plan, onGenerate }: { plan: RacePlan; onGenerate(input: RacePlanInput, sources: StintSummary[]): void }) {
  const { m, Button } = useRaceStrategyHost();
  const recalculate = useRecalculateRacePlan();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const fractional = plan.fuelUnit === "tankFraction";
  const factor = fractional ? 100 : 1;
  const [capacity, setCapacity] = useState(plan.generation ? String(plan.generation.fuelCapacity * factor) : "");
  const [reserve, setReserve] = useState(String((plan.generation?.fuelReserve ?? 0) * factor));
  const [energyReserve, setEnergyReserve] = useState(String((plan.generation?.energyReserveFraction ?? 0) * 100));
  const [invalid, setInvalid] = useState(false);
  const submit = async () => {
    const generation = parseConstraints(fractional, capacity, reserve, energyReserve);
    if (!generation) { setInvalid(true); return; }
    setInvalid(false);
    try {
      const result = await recalculate.mutateAsync({ id: plan.id, generation });
      if (!mounted.current) return;
      onGenerate({ ...result.draft, name: m.race_plan_copy_name({ name: result.draft.name }).slice(0, 120) }, result.sources);
    } catch { /* Mutation retains the error and form values for retry. */ }
  };
  return <section data-testid="race-strategy-recalculator" className="space-y-3 rounded border border-app-border bg-app-surface p-4">
    <h2 className="text-app-heading font-semibold">{m.race_plan_recalculate()} · {plan.name}</h2>
    <p className="max-w-prose text-app-subtext text-app-text-muted">{m.race_plan_recalculate_help()}</p>
    {plan.gameId === "lmu" && <p className="max-w-prose text-app-detail text-app-text-muted">{m.race_plan_energy_assumption()}</p>}
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3"><ResourceFields gameId={plan.gameId} fractional={fractional} energy={plan.gameId === "lmu"} capacity={capacity} reserve={reserve} energyReserve={energyReserve} onCapacity={setCapacity} onReserve={setReserve} onEnergyReserve={setEnergyReserve} disabled={recalculate.isPending} /></div>
      {(invalid || recalculate.isError) && <p role="alert" className="text-app-detail text-status-danger">{m.race_plan_recalculate_error()}</p>}
      <Button type="submit" variant="app-primary" disabled={recalculate.isPending}>{recalculate.isPending ? m.common_loading() : m.race_plan_recalculate()}</Button>
    </form>
  </section>;
}

type Editor = { plan?: RacePlan; draft?: RacePlanInput; baseline?: RacePlanBaseline; cloneName?: string; sources?: StintSummary[]; original?: RacePlan };

export function RaceStrategiesPage({ gameId, sessionId }: { gameId: GameId; sessionId?: number }) {
  const { m, Button } = useRaceStrategyHost();
  const plans = useRacePlans(gameId);
  const active = useActiveRacePlans();
  const activate = useSetActiveRacePlan();
  const remove = useDeleteRacePlan(gameId);
  const [generating, setGenerating] = useState(sessionId != null);
  const [recalculating, setRecalculating] = useState<RacePlan | null>(null);
  const [editing, setEditing] = useState<Editor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const openEditor = (editor: Editor) => { setEditing(editor); setGenerating(false); setRecalculating(null); setError(null); };
  return <section className="min-w-0 space-y-4" data-testid="race-strategies-page">
    <header className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-app-title font-semibold">{m.race_plan_strategies()}</h1>{!editing && <div className="flex flex-wrap gap-2">
      <Button variant="app-outline" onClick={() => openEditor({})}>{m.race_plan_new()}</Button>
      <Button variant="app-primary" onClick={() => { setGenerating(true); setRecalculating(null); }}>{m.race_plan_generate()}</Button>
    </div>}</header>
    {editing && <>
      <Button variant="app-outline" disabled={saving} onClick={() => setEditing(null)}>{m.race_plan_strategies()}</Button>
      {editing.original && editing.draft && <p data-testid="recalculation-summary" className="text-app-detail tabular-nums">{m.race_plan_recalculated_summary({ beforeLaps: editing.original.totalLaps, afterLaps: editing.draft.totalLaps, beforeStops: editing.original.stints.length - 1, afterStops: editing.draft.stints.length - 1 })}</p>}
      {editing.sources && <section aria-label={m.race_plan_latest_evidence()} className="space-y-2 rounded border border-app-border bg-app-surface-alt p-3 text-app-detail">
        <h2 className="font-semibold">{m.race_plan_latest_evidence()}</h2>
        {editing.sources.map((source) => <div key={source.id} className="space-y-1 break-words tabular-nums">
          <p>{m.review_session()} {source.sessionId} · {m.strategy_stint({ ordinal: source.ordinal })} · {new Date(source.endedAt ?? source.startedAt).toLocaleString()}</p>
          <p>{m.strategy_average_lap()}: {source.averageLapSeconds?.toFixed(2) ?? m.strategy_unavailable()} s · {m.strategy_fuel_rate()}: {source.fuel.value == null ? m.strategy_unavailable() : source.fuelUnit === "L" ? m.strategy_rate_litres({ value: source.fuel.value.toFixed(2) }) : m.strategy_rate_points({ value: (source.fuel.value * 100).toFixed(2) })} · {m.strategy_eligible_laps({ count: source.fuel.eligibleLaps })}</p>
          <p>{source.tires.map((rate, index) => `${["FL", "FR", "RL", "RR"][index]} ${rate.value == null ? m.strategy_unavailable() : m.strategy_rate_points({ value: (rate.value * 100).toFixed(2) })}`).join(" · ")}</p>
          {source.gameId === "lmu" && <p>{m.race_plan_energy_rate({ value: source.virtualEnergy?.value == null ? m.strategy_unavailable() : (source.virtualEnergy.value * 100).toFixed(2) })}</p>}
          {source.compatibility.setupKey == null && <p className="text-app-text-muted">{m.strategy_setup_uncertain()}</p>}
        </div>)}
      </section>}
      <RaceStrategyPlanner key={`${editing.plan?.id ?? "new"}:${editing.cloneName ?? "edit"}`} gameId={gameId} sessionId={sessionId} initialPlan={editing.plan} initialDraft={editing.draft} initialBaseline={editing.baseline} cloneName={editing.cloneName} initialSources={editing.sources} onSavingChange={setSaving} />
    </>}
    {!editing && recalculating && <StrategyRecalculator key={recalculating.id} plan={recalculating} onGenerate={(draft, sources) => openEditor({ draft, sources, baseline: aggregateRacePlanEvidence(sources, draft.weather ?? "any") ?? undefined, original: recalculating })} />}
    {!editing && generating && !recalculating && <StrategyGenerator gameId={gameId} onGenerate={(draft, baseline) => openEditor({ draft, baseline })} onManual={() => openEditor({})} />}
    {!editing && <section aria-label={m.race_plan_saved()} className="space-y-3">
      {plans.isLoading && <p role="status" className="text-app-detail">{m.common_loading()}</p>}
      {plans.isError && <p role="alert">{m.race_plan_load_error()} <Button variant="app-ghost" onClick={() => void plans.refetch()}>{m.strategy_retry()}</Button></p>}
      {active.isError && <p role="alert">{m.race_plan_live_error()} <Button variant="app-ghost" onClick={() => void active.refetch()}>{m.strategy_retry()}</Button></p>}
      {!plans.isLoading && !plans.isError && plans.data?.plans.length === 0 && <p className="rounded border border-app-border bg-app-surface p-4 text-app-subtext text-app-text-muted">{m.race_plan_empty()}</p>}
      {error && <p role="alert" className="text-app-detail text-status-danger">{error}</p>}
      {(plans.data?.plans ?? []).length > 0 && <div data-testid="saved-strategies-table" className="overflow-hidden rounded border border-app-border bg-app-surface"><ul className="divide-y divide-app-border">
        {(plans.data?.plans ?? []).map((plan) => <li key={plan.id} className="grid min-w-0 gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div className="min-w-0 space-y-1">
            <button type="button" className="max-w-full break-words text-left text-app-subtext font-semibold text-app-text hover:text-app-accent focus-visible:outline-2 focus-visible:outline-app-accent" onClick={() => openEditor({ plan })}>{plan.name}</button>
            <p className="break-words text-app-detail text-app-text-muted">{m.analyse_car_label()}: {plan.carId} · {m.analyse_track_label()}: {plan.trackId}</p>
            <p className="text-app-detail tabular-nums">{m.race_plan_laps({ count: plan.totalLaps })} · {m.race_plan_stints()}: {plan.stints.length}{active.data?.plans.some((loaded) => loaded.gameId === plan.gameId && loaded.carId === plan.carId && loaded.trackId === plan.trackId && loaded.id === plan.id) && <span className="ml-2 text-app-accent">{m.race_plan_loaded()}</span>}</p>
          </div>
          <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label={plan.name}>
            <Button variant="app-outline" size="app-sm" onClick={() => openEditor({ plan, cloneName: m.race_plan_copy_name({ name: plan.name }).slice(0, 120) })}>{m.race_plan_clone()}</Button>
            <Button variant="app-outline" size="app-sm" onClick={() => { setRecalculating(plan); setGenerating(false); setError(null); }}>{m.race_plan_recalculate()}</Button>
            <Button variant="app-outline" size="app-sm" disabled={activate.isPending || active.isError || active.isLoading} onClick={() => { setError(null); const loaded = active.data?.plans.some((item) => item.gameId === plan.gameId && item.carId === plan.carId && item.trackId === plan.trackId && item.id === plan.id); activate.mutate({ gameId: plan.gameId, carId: plan.carId, trackId: plan.trackId, planId: loaded ? null : plan.id }, { onError: () => setError(m.race_plan_load_error()) }); }}>{active.data?.plans.some((item) => item.gameId === plan.gameId && item.carId === plan.carId && item.trackId === plan.trackId && item.id === plan.id) ? m.race_plan_unload() : m.race_plan_load()}</Button>
            <Button variant="app-ghost" size="app-sm" disabled={remove.isPending} onClick={() => { setError(null); remove.mutate(plan.id, { onError: () => setError(m.race_plan_delete_error()) }); }}>{m.race_plan_delete()}</Button>
          </div>
        </li>)}
      </ul></div>}
    </section>}
  </section>;
}
