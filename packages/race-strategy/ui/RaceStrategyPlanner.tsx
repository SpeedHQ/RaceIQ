import { supportsRaceRefueling } from "../contracts/race-rules";
import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import type { GameId } from "@raceiq/shared/games/ids";
import { getGame } from "@raceiq/shared/games/registry";
import { getTireCompoundOptions, getTireThresholds } from "@raceiq/shared/racing/live/tire-thresholds";
import { estimateRaceLaps, type RacePlan, type RacePlanInput, type RacePlanStintInput, type RacePlanLength } from "@raceiq/shared/racing/live/race-plan";
import type { StintSummary, StrategyFuelUnit } from "@raceiq/shared/racing/live/strategy";
import { StintsResponseSchema } from "@raceiq/shared/racing/live/strategy-schemas";
import { useSaveRacePlan, useSetActiveRacePlan } from "./race-plans";
import { strategyKeys } from "./stint-strategy";
import { useRaceStrategyHost } from "./host";
import { projectRacePlanStint } from "./race-plan-projection";

const wheels = ["FL", "FR", "RL", "RR"] as const;
type PlannerDraft = RacePlanInput & { id?: string };
type RetryAction = { type: "save" };
function toDraft(plan: RacePlan): PlannerDraft {
  const { id, name, gameId, carId, trackId, pi, totalLaps, raceLength, fuelUnit, notes, generation } = plan;
  return { id, name, gameId, carId, trackId, pi, totalLaps, raceLength: raceLength ?? { mode: "laps" }, fuelUnit, notes, generation, stints: plan.stints.map(({ evidence: _evidence, ...stint }) => stint) };
}
function emptyStint(endLap: number): RacePlanStintInput {
  return { endLap, startFuel: null, compounds: [null, null, null, null], sourceSessionId: null, sourceStintId: null };
}
function makeDraft(gameId: GameId, carId: string, trackId: string, pi: number | null): PlannerDraft {
  const fuelUnit = getGame(gameId).telemetry.fuel.packetUnit === "fraction" ? "tankFraction" : "L";
  return { name: "", gameId, carId, trackId, pi, totalLaps: 20, raceLength: { mode: "laps" }, fuelUnit, notes: "", stints: [emptyStint(20)] };
}
function validDraft(draft: PlannerDraft) {
  if (draft.raceLength?.mode === "time" && estimateRaceLaps(draft.raceLength.durationSeconds, draft.raceLength.averageLapSeconds) !== draft.totalLaps) return false;
  return draft.name.trim().length > 0 && draft.name.trim().length <= 120 && draft.carId.trim().length > 0 && draft.trackId.trim().length > 0 &&
    draft.totalLaps >= 1 && draft.totalLaps <= 10_000 && Number.isInteger(draft.totalLaps) && draft.stints.length > 0 && draft.stints.length <= 100 &&
    draft.stints.every((stint, index) => Number.isInteger(stint.endLap) && stint.endLap > (draft.stints[index - 1]?.endLap ?? 0) && stint.endLap <= draft.totalLaps && (stint.startFuel == null || Number.isFinite(stint.startFuel) && stint.startFuel >= 0 && (draft.fuelUnit !== "tankFraction" || stint.startFuel <= 1))) &&
    draft.stints.at(-1)?.endLap === draft.totalLaps && draft.stints.every((stint) => (stint.sourceSessionId == null) === (stint.sourceStintId == null)) &&
    (draft.gameId !== "fm-2023" || draft.pi != null);
}

export function RaceStrategyPlanner({ gameId, sessionId, carId, trackId, pi, initialPlan, initialDraft, cloneName, initialSources, onSavingChange }: {
  gameId: GameId; sessionId?: number | null; carId?: string | null; trackId?: string | null; pi?: number | null;
  initialPlan?: RacePlan; initialDraft?: RacePlanInput; cloneName?: string; initialSources?: StintSummary[]; onSavingChange?: (pending: boolean) => void;
}) {
  const { m, api, useSessions, useSettings, useTelemetryState, Button, Input, Select, Textarea } = useRaceStrategyHost();
  const sessionsQuery = useSessions({ allGames: true });
  const sessions = useMemo(() => (sessionsQuery.data ?? []).filter((session) => session.gameId === gameId && session.ownership === "mine"), [sessionsQuery.data, gameId]);
  const save = useSaveRacePlan(gameId);
  useEffect(() => { onSavingChange?.(save.isPending); }, [onSavingChange, save.isPending]);
  const activate = useSetActiveRacePlan();
  const { displaySettings } = useSettings();
  const overrides = displaySettings.tireThresholdOverrides ?? {};
  const initialSession = sessions.find((item) => item.id === sessionId);
  const [draft, setDraft] = useState<PlannerDraft>(() => {
    const input = initialPlan ? toDraft(initialPlan) : initialDraft ?? makeDraft(gameId, carId ?? initialSession?.carId ?? "", trackId ?? initialSession?.trackId ?? "", pi ?? null);
    return cloneName == null ? input : { ...input, id: undefined, name: cloneName };
  });
  const [savedCombo, setSavedCombo] = useState(() => cloneName == null && initialPlan ? { gameId: initialPlan.gameId, carId: initialPlan.carId, trackId: initialPlan.trackId } : null);
  const liveView = useTelemetryState((state) => state.telemetryView);
  const liveLaps = useTelemetryState((state) => state.sessionLaps);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryAction, setRetryAction] = useState<RetryAction | null>(null);
  const [sourceSnapshots, setSourceSnapshots] = useState(() => new Map<string, StintSummary>([
    ...(initialPlan?.stints.flatMap((stint) => stint.evidence ? [stint.evidence] : []) ?? []), ...(initialSources ?? []),
  ].map((source) => [`${source.sessionId}:${source.id}`, source])));
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(initialPlan?.stints.find((stint) => stint.sourceSessionId != null)?.sourceSessionId ?? initialDraft?.stints[0]?.sourceSessionId ?? sessionId ?? null);
  useEffect(() => {
    const selected = sessions.find((session) => session.id === selectedSessionId);
    if (selected) setDraft((current) => current.carId || current.trackId ? current : { ...current, carId: selected.carId, trackId: selected.trackId });
  }, [selectedSessionId, sessions]);
  const sourceSessionIds = [...new Set([selectedSessionId, ...draft.stints.map((stint) => stint.sourceSessionId)].filter((id): id is number => id != null && sessions.some((session) => session.id === id)))];
  const sourceSessions = sessions.filter((session) => sourceSessionIds.includes(session.id));
  const sourceQueries = useQueries({ queries: sourceSessions.map((session) => ({
    queryKey: strategyKeys.stints(gameId, session.id),
    queryFn: async () => StintsResponseSchema.parse(await api.stints(gameId, session.id)),
    refetchOnMount: "always" as const,
  })) });
  const sources = sourceQueries.flatMap((query, index) => (query.data?.stints ?? []).filter((stint) => stint.status === "completed" || stint.status === "interrupted").map((stint) => ({ session: sourceSessions[index]!, stint })));
  const update = (patch: Partial<PlannerDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const sourceKey = (sourceSessionId: number | null, sourceStintId: string | null) => `${sourceSessionId}:${sourceStintId}`;
  const sourceFor = (stint: RacePlanStintInput) => sourceSnapshots.get(sourceKey(stint.sourceSessionId, stint.sourceStintId)) ?? sources.find(({ session, stint: source }) => source.sessionId === stint.sourceSessionId && source.id === stint.sourceStintId && session.ownership === "mine")?.stint ?? null;
  const paceSource = draft.stints.map(sourceFor).find((source) => source != null &&
    source.gameId === draft.gameId && source.carId === draft.carId && source.trackId === draft.trackId &&
    (draft.gameId !== "fm-2023" || source.pi === draft.pi) && source.paceLaps > 0 &&
    source.averageLapSeconds != null && Number.isFinite(source.averageLapSeconds) && source.averageLapSeconds > 0);
  const matchingLive = liveView?.simulator === draft.gameId && liveView.identity.carId === draft.carId &&
    liveView.identity.trackId === draft.trackId && (draft.gameId !== "fm-2023" || liveView.identity.performanceIndex === draft.pi);
  const paceLaps = matchingLive && sessionId != null
    ? liveLaps.filter((lap) => lap.sessionId === sessionId && lap.isValid && lap.classification === "pace" && Number.isFinite(lap.lapTime) && lap.lapTime > 0)
    : [];
  const measuredPace = paceSource?.averageLapSeconds ?? (paceLaps.length ? paceLaps.reduce((sum, lap) => sum + lap.lapTime, 0) / paceLaps.length : null);
  const timedLength = draft.raceLength?.mode === "time" ? draft.raceLength : null;
  const estimatedLaps = timedLength ? estimateRaceLaps(timedLength.durationSeconds, timedLength.averageLapSeconds) : null;
  const setRaceLength = (raceLength: RacePlanLength) => setDraft((current) => {
    const totalLaps = raceLength.mode === "time" ? estimateRaceLaps(raceLength.durationSeconds, raceLength.averageLapSeconds) : null;
    return { ...current, raceLength, ...(totalLaps == null ? {} : {
      totalLaps,
      stints: current.stints.map((stint, index) => index === current.stints.length - 1 ? { ...stint, endLap: totalLaps } : stint),
    }) };
  });
  const compatibleSources = (targetIndex: number) => {
    const attachedSources = draft.stints.flatMap((stint, row) => {
      if (row === targetIndex || stint.sourceSessionId == null || stint.sourceStintId == null) return [];
      const source = sourceFor(stint);
      return source ? [source] : [];
    });
    return sources.filter(({ session, stint }) => {
      const planStint = draft.stints[targetIndex]!;
      const sameIdentity = stint.gameId === draft.gameId && stint.carId === draft.carId && stint.trackId === draft.trackId &&
        (draft.gameId !== "fm-2023" || (draft.pi == null ? attachedSources.every((source) => source.pi === stint.pi) : stint.pi === draft.pi));
      const matchesFuel = stint.fuelUnit === draft.fuelUnit;
      const compounds = planStint.compounds.every((compound, index) => compound == null || compound === stint.compounds[index]);
      const selectedSession = selectedSessionId == null || session.id === selectedSessionId || planStint.sourceSessionId === session.id;
      const currentSource = planStint.sourceSessionId === session.id && planStint.sourceStintId === stint.id;
      return session.ownership === "mine" && selectedSession && (currentSource || sameIdentity && matchesFuel && compounds);
    });
  };
  const draftSourcesValid = draft.stints.every((stint) => {
    if (stint.sourceSessionId == null && stint.sourceStintId == null) return true;
    const source = sources.find(({ session, stint: item }) => session.ownership === "mine" && item.sessionId === stint.sourceSessionId && item.id === stint.sourceStintId);
    return source != null && source.stint.gameId === draft.gameId && source.stint.carId === draft.carId && source.stint.trackId === draft.trackId && (draft.gameId !== "fm-2023" || source.stint.pi === draft.pi) && source.stint.fuelUnit === draft.fuelUnit && stint.compounds.every((compound, index) => compound === source.stint.compounds[index]);
  });
  const draftValid = validDraft(draft) && draftSourcesValid;
  const chooseSource = (index: number, value: string) => {
    const separator = value.indexOf(":");
    const sourceSessionId = separator === -1 ? "" : value.slice(0, separator);
    const sourceStintId = separator === -1 ? "" : value.slice(separator + 1);
    const candidate = sources.find(({ session, stint }) => String(session.id) === sourceSessionId && stint.id === sourceStintId);
    const isCompatible = !candidate || compatibleSources(index).some(({ session, stint }) => session.id === candidate.session.id && stint.id === candidate.stint.id);
    if (value && (!candidate || !isCompatible)) { setError(m.race_plan_source_unavailable()); return; }
    const source = candidate?.stint;
    const stints = draft.stints.map((item, row) => row === index ? { ...item, sourceSessionId: source?.sessionId ?? null, sourceStintId: source?.id ?? null, compounds: source ? source.compounds : [null, null, null, null] as RacePlanStintInput["compounds"] } : item);
    setDraft((current) => {
      const otherSources = current.stints.flatMap((item, row) => {
        if (row === index || item.sourceSessionId == null || item.sourceStintId == null) return [];
        const evidence = sourceFor(item);
        return evidence ? [{ stint: item, evidence }] : [];
      });
      return {
        ...current,
        ...(source && otherSources.length === 0 ? { carId: source.carId, trackId: source.trackId, pi: source.pi, fuelUnit: source.fuelUnit, generation: source.fuelUnit === current.fuelUnit ? current.generation : null } :
          source && current.pi == null && otherSources.every(({ stint: attached, evidence }) =>
            evidence.gameId === source.gameId && evidence.carId === source.carId && evidence.trackId === source.trackId &&
            evidence.pi === source.pi && evidence.fuelUnit === source.fuelUnit &&
            attached.compounds.every((compound, slot) => compound === evidence.compounds[slot])
          ) ? { pi: source.pi } : {}),
        stints,
      };
    });
    if (source) setSourceSnapshots((previous) => new Map(previous).set(sourceKey(source.sessionId, source.id), source));
    setSelectedSessionId(source?.sessionId ?? selectedSessionId); setError(null); setNotice(null);
  };
  const selectSession = (value: string) => {
    const selected = sessions.find((session) => session.id === Number(value));
    setSelectedSessionId(selected?.id ?? null);
    setDraft((current) => ({ ...current, ...(selected ? {
      carId: selected.carId,
      trackId: selected.trackId,
      pi: current.carId === selected.carId && current.trackId === selected.trackId ? current.pi : null,
    } : {}) }));
    setError(null); setNotice(null);
  };
  const setStint = (index: number, patch: Partial<RacePlanStintInput>) => update({ stints: draft.stints.map((stint, row) => row === index ? { ...stint, ...patch } : stint) });
  const createBlank = () => { setDraft(makeDraft(gameId, carId ?? initialSession?.carId ?? "", trackId ?? initialSession?.trackId ?? "", pi ?? null)); setSavedCombo(null); setSelectedSessionId(sessionId ?? null); setError(null); setNotice(null); setRetryAction(null); };
  const savePlan = async () => {
    if (!draftValid) { setError(draftSourcesValid ? m.race_plan_invalid() : m.race_plan_source_unavailable()); return; }
    setError(null); setNotice(null); setRetryAction(null);
    const { id, ...input } = draft;
    try {
      const saved = await save.mutateAsync({ id, input });
      setDraft(toDraft(saved));
      setSavedCombo({ gameId: saved.gameId, carId: saved.carId, trackId: saved.trackId });
      setSourceSnapshots((previous) => new Map([...previous, ...saved.stints.flatMap((stint) => stint.evidence ? [[sourceKey(stint.sourceSessionId, stint.sourceStintId), stint.evidence] as const] : [])]));
      setNotice(m.race_plan_saved_notice());
    } catch { setError(m.race_plan_save_error()); setRetryAction({ type: "save" }); }
  };
  const thresholds = (compound: string) => getTireThresholds(overrides, gameId, compound);
  const forecasts = draft.stints.map((stint, index) => {
    const result = projectRacePlanStint(stint, draft.stints[index - 1]?.endLap ?? 0, draft, sourceFor(stint), thresholds);
    return timedLength && estimatedLaps == null
      ? { ...result, consumed: null, fuelEnd: null, fuelWarning: false, tires: result.tires.map((tire) => ({ ...tire, health: null })) }
      : result;
  });
  const fuelText = (value: number) => draft.fuelUnit === "tankFraction" ? `${(value * 100).toFixed(1)}%` : `${value.toFixed(1)} L`;
  return <section data-testid="race-strategy-planner" className="min-w-0 space-y-4 rounded border border-app-border bg-app-surface p-4" aria-labelledby="race-plan-title">
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3"><div><h2 id="race-plan-title" className="text-app-heading font-semibold">{m.race_plan_title()}</h2><p className="mt-1 text-app-subtext text-app-text-muted">{m.race_plan_generate_help()}</p></div><Button variant="app-outline" type="button" disabled={save.isPending} onClick={createBlank}>{m.race_plan_new()}</Button></div>
    {(sessionsQuery.isError || sourceQueries.some((query) => query.isError)) && <p role="alert" className="text-app-detail text-status-danger">{m.race_plan_sources_error()} <Button variant="app-outline" type="button" className="underline" onClick={() => { void sessionsQuery.refetch(); sourceQueries.forEach((query) => void query.refetch()); }}>{m.strategy_retry()}</Button></p>}
      <div className="min-w-0 space-y-3">
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="min-w-0 text-app-detail">{m.race_plan_name()}<Input className="mt-1 w-full min-w-0 bg-app-surface-alt text-app-detail" disabled={save.isPending} maxLength={120} value={draft.name} onChange={(event) => update({ name: event.target.value })} /></label>
          <label className="min-w-0 text-app-detail">{m.race_plan_source_session()}<Select className="mt-1 w-full min-w-0 bg-app-surface-alt text-app-detail" disabled={save.isPending} value={selectedSessionId ?? ""} onChange={(event) => selectSession(event.target.value)}><option value="">{m.race_plan_manual_source()}</option>{sessions.map((session) => <option key={session.id} value={session.id}>{m.review_session()} {session.id} · {new Date(session.createdAt).toLocaleDateString()} · {session.carId}/{session.trackId}</option>)}</Select></label>
          <label className="min-w-0 text-app-detail">{m.race_plan_length_mode()}<Select aria-label={m.race_plan_length_mode()} className="mt-1 w-full bg-app-surface-alt text-app-detail" disabled={save.isPending} value={timedLength ? "time" : "laps"} onChange={(event) => setRaceLength(event.target.value === "time" ? { mode: "time", durationSeconds: 0, averageLapSeconds: measuredPace ?? 0 } : { mode: "laps" })}><option value="laps">{m.label_laps()}</option><option value="time">{m.race_plan_time()}</option></Select></label>
          {timedLength ? <>
            <label className="min-w-0 text-app-detail">{m.race_plan_duration_minutes()}<Input className="mt-1 w-full bg-app-surface-alt text-app-detail" disabled={save.isPending} type="number" min={0} max={10080} step="any" value={timedLength.durationSeconds === 0 ? "" : timedLength.durationSeconds / 60} onChange={(event) => setRaceLength({ ...timedLength, durationSeconds: Number(event.target.value) * 60 })} /></label>
            <label className="min-w-0 text-app-detail">{m.strategy_average_lap()} (s)<Input className="mt-1 w-full bg-app-surface-alt text-app-detail" disabled={save.isPending} type="number" min={0} max={86400} step="any" value={timedLength.averageLapSeconds === 0 ? "" : timedLength.averageLapSeconds} onChange={(event) => setRaceLength({ ...timedLength, averageLapSeconds: Number(event.target.value) })} /></label>
            <div className="min-w-0 text-app-detail sm:col-span-2">
              <p data-testid="race-time-estimate" role="status">{estimatedLaps == null ? m.race_plan_time_unavailable() : m.race_plan_time_estimate({ laps: estimatedLaps, seconds: timedLength.averageLapSeconds.toFixed(2) })}</p>
              <Button variant="app-ghost" type="button" className="mt-1" disabled={save.isPending || measuredPace == null} onClick={() => { if (measuredPace != null) setRaceLength({ ...timedLength, averageLapSeconds: measuredPace }); }}>{m.race_plan_use_measured_pace()}</Button>
            </div>
          </> : <label className="min-w-0 text-app-detail">{m.race_plan_total_laps()}<Input className="mt-1 w-full bg-app-surface-alt text-app-detail" disabled={save.isPending} type="number" min={1} max={10000} step={1} value={draft.totalLaps} onChange={(event) => {
            const totalLaps = Number(event.target.value);
            update({ totalLaps, stints: draft.stints.map((stint, index) => index === draft.stints.length - 1 ? { ...stint, endLap: totalLaps } : stint) });
          }} /></label>}
          <label className="min-w-0 text-app-detail">{m.race_plan_fuel_unit()}<Select className="mt-1 w-full bg-app-surface-alt text-app-detail" disabled={save.isPending} value={draft.fuelUnit} onChange={(event) => update({ fuelUnit: event.target.value as StrategyFuelUnit, generation: null })}><option value="L">L</option><option value="tankFraction">{m.race_plan_tank_fraction()}</option></Select></label>
          <label className="min-w-0 text-app-detail">{m.analyse_car_label()}<Input className="mt-1 w-full min-w-0 bg-app-surface-alt text-app-detail" disabled={save.isPending} value={draft.carId} onChange={(event) => update({ carId: event.target.value })} /></label>
          <label className="min-w-0 text-app-detail">{m.analyse_track_label()}<Input className="mt-1 w-full min-w-0 bg-app-surface-alt text-app-detail" disabled={save.isPending} value={draft.trackId} onChange={(event) => update({ trackId: event.target.value })} /></label>
          {gameId === "fm-2023" && <label className="min-w-0 text-app-detail">{m.cars_pi()}<Input className="mt-1 w-full bg-app-surface-alt text-app-detail" disabled={save.isPending} type="number" value={draft.pi ?? ""} onChange={(event) => update({ pi: event.target.value ? Number(event.target.value) : null })} /></label>}
          <label className="min-w-0 text-app-detail sm:col-span-2">{m.race_plan_notes()}<Textarea className="mt-1 w-full min-w-0 bg-app-surface-alt text-app-detail" disabled={save.isPending} maxLength={4000} rows={2} value={draft.notes} onChange={(event) => update({ notes: event.target.value })} /></label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{m.race_plan_stints()}</h3><Button variant="app-outline" type="button" disabled={save.isPending || draft.stints.length >= 100 || draft.totalLaps < 2} onClick={() => update({ stints: [...draft.stints.slice(0, -1), { ...draft.stints.at(-1)!, endLap: Math.max(1, draft.totalLaps - 1) }, emptyStint(draft.totalLaps)] })}>{m.race_plan_add_stop()}</Button></div>
        {draft.stints.map((stint, index) => {
          const previousEnd = draft.stints[index - 1]?.endLap ?? 0;
          const evidence = sourceFor(stint);
          const forecast = forecasts[index]!;
          const previousFuel = forecasts[index - 1]?.fuelEnd;
          const fuelToAdd = supportsRaceRefueling(gameId) && previousFuel != null && Number.isFinite(previousFuel) && previousFuel >= 0 && stint.startFuel != null && Number.isFinite(stint.startFuel) ? Math.max(0, stint.startFuel - previousFuel) : null;
          const compatible = compatibleSources(index);
          const sourceValue = stint.sourceSessionId == null || stint.sourceStintId == null ? "" : `${stint.sourceSessionId}:${stint.sourceStintId}`;
          const compoundOptions = [...new Set([...getTireCompoundOptions(gameId), ...stint.compounds.filter((value): value is string => value != null)])];
          return <fieldset key={`${index}:${stint.sourceStintId ?? "manual"}`} className="min-w-0 space-y-3 rounded border border-app-border p-3">
            <legend className="px-1 text-app-detail font-medium">{m.race_plan_stint({ ordinal: index + 1 })}</legend>
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <label className="min-w-0 text-app-detail">{m.race_plan_end_lap()}<Input className="mt-1 w-full bg-app-surface-alt text-app-detail" disabled={save.isPending || timedLength != null && index === draft.stints.length - 1} type="number" min={previousEnd + 1} max={draft.totalLaps} value={stint.endLap} onChange={(event) => setStint(index, { endLap: Number(event.target.value) })} /></label>
              <label className="min-w-0 text-app-detail">{m.race_plan_evidence()}<Select className="mt-1 w-full min-w-0 bg-app-surface-alt text-app-detail" disabled={save.isPending} value={sourceValue} onChange={(event) => chooseSource(index, event.target.value)}><option value="">{m.race_plan_manual_source()}</option>{sourceValue && !compatible.some(({ stint: source }) => source.id === stint.sourceStintId) && <option value={sourceValue}>{m.race_plan_source_unavailable()}</option>}{compatible.map(({ session, stint: source }) => <option key={`${session.id}:${source.id}`} value={`${session.id}:${source.id}`}>{m.review_session()} {session.id} · {m.strategy_stint({ ordinal: source.ordinal })} · {new Date(source.endedAt ?? source.startedAt).toLocaleString()}</option>)}</Select></label>
              {supportsRaceRefueling(gameId) && <label className="min-w-0 text-app-detail">{m.race_plan_start_fuel()} ({draft.fuelUnit === "tankFraction" ? "%" : "L"})<Input className="mt-1 w-full bg-app-surface-alt text-app-detail" disabled={save.isPending} type="number" min={0} max={draft.fuelUnit === "tankFraction" ? 100 : undefined} step="any" value={stint.startFuel == null ? "" : draft.fuelUnit === "tankFraction" ? stint.startFuel * 100 : stint.startFuel} onChange={(event) => setStint(index, { startFuel: event.target.value === "" ? null : draft.fuelUnit === "tankFraction" ? Number(event.target.value) / 100 : Number(event.target.value) })} /></label>}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{wheels.map((wheel, wheelIndex) => <label key={wheel} className="min-w-0 text-app-detail">{wheel} {m.label_tires()}<Select aria-label={`${wheel} ${m.label_tires()}`} className="mt-1 w-full min-w-0 bg-app-surface-alt text-app-detail" disabled={save.isPending} value={stint.compounds[wheelIndex] ?? ""} onChange={(event) => setStint(index, { compounds: stint.compounds.map((value, slot) => slot === wheelIndex ? event.target.value || null : value) as RacePlanStintInput["compounds"] })}><option value="">{m.strategy_unknown()}</option>{compoundOptions.map((compound) => <option key={compound} value={compound}>{compound}</option>)}</Select></label>)}</div>
            {evidence ? <div className="space-y-1 border-t border-app-border pt-2 text-app-compact text-app-text-muted"><p>{m.race_plan_snapshot({ session: evidence.sessionId, stint: evidence.ordinal, laps: evidence.completedLaps, fuelLaps: evidence.fuel.eligibleLaps, tireLaps: evidence.tires.map((rate) => rate.eligibleLaps).join("/") })}</p><p>{m.race_plan_source_details({ date: new Date(evidence.endedAt ?? evidence.startedAt).toLocaleString(), status: evidence.status, setup: evidence.compatibility.setupKey ?? m.strategy_unknown(), conditions: evidence.compatibility.conditions.weather ?? m.strategy_unknown() })}</p></div> : <p className="text-app-compact text-app-text-muted">{m.race_plan_no_evidence()}</p>}
            <div className="grid min-w-0 gap-2 sm:grid-cols-2">
              <p className="break-words text-app-detail tabular-nums">{m.race_plan_duration({ laps: forecast.laps })}{supportsRaceRefueling(gameId) && <><br />{forecast.consumed == null ? m.race_plan_projection_unavailable() : m.race_plan_fuel_used({ value: draft.fuelUnit === "tankFraction" ? (forecast.consumed * 100).toFixed(1) : forecast.consumed.toFixed(1), unit: draft.fuelUnit === "tankFraction" ? "%" : "L" })} · {forecast.fuelEnd == null ? m.race_plan_fuel_end_unknown() : m.race_plan_fuel_end({ value: draft.fuelUnit === "tankFraction" ? `${(forecast.fuelEnd * 100).toFixed(1)}%` : `${forecast.fuelEnd.toFixed(1)} L` })}{forecast.fuelWarning && <strong className="block text-status-danger">{m.race_plan_fuel_short()}</strong>}</>}</p>
              <div className="min-w-0 space-y-1 text-app-detail text-app-text-muted tabular-nums"><p>{m.race_plan_fresh_tires()}</p>{forecast.tires.map((tire, wheelIndex) => <div key={wheels[wheelIndex]}>
                <p>{wheels[wheelIndex]} · {tire.health == null ? m.race_plan_projection_unavailable() : `${tire.health.toFixed(1)}%`} · {m.pit_cliff()} {tire.cliffPct}% · {m.pit_dead()} {tire.deadPct}%{tire.health != null && tire.health <= tire.deadPct ? ` · ${m.race_plan_dead_warning()}` : tire.health != null && tire.health <= tire.cliffPct ? ` · ${m.race_plan_cliff_warning()}` : ""}</p>
                <p data-testid="race-plan-tire-life">{stint.compounds[wheelIndex] ?? m.strategy_unknown()} · {tire.zeroWear ? m.race_plan_tire_no_wear() : tire.cliffLaps == null || tire.deadLaps == null ? m.strategy_unavailable() : m.race_plan_tire_life({ cliff: tire.cliffLaps.toFixed(1), dead: tire.deadLaps.toFixed(1) })}</p>
              </div>)}</div>
            </div>
            {supportsRaceRefueling(gameId) && <p data-testid="race-plan-required-fuel" className="text-app-detail font-semibold tabular-nums">{m.race_plan_required_fuel({ value: forecast.consumed == null ? m.strategy_unavailable() : fuelText(forecast.consumed) })}</p>}
            {draft.gameId === "lmu" && <div className="space-y-1 text-app-detail tabular-nums">
              <p data-testid="race-plan-required-energy">{m.race_plan_energy_required({ value: forecast.virtualEnergyUsed == null ? m.strategy_unavailable() : (forecast.virtualEnergyUsed * 100).toFixed(1) })}</p>
              <p className="text-app-text-muted">{m.race_plan_energy_assumption()}</p>
            </div>}
            {supportsRaceRefueling(gameId) && index > 0 && <p data-testid="race-plan-refuel" className="text-app-detail">{fuelToAdd == null ? m.race_plan_refuel_unavailable() : m.race_plan_refuel({ value: fuelText(fuelToAdd) })}</p>}
            {draft.stints.length > 1 && <Button variant="app-outline" type="button" disabled={save.isPending} onClick={() => update({ stints: draft.stints.filter((_, row) => row !== index).map((item, row, all) => row === all.length - 1 ? { ...item, endLap: draft.totalLaps } : item) })}>{m.race_plan_remove_stint()}</Button>}
          </fieldset>;
        })}
        <div className="flex flex-wrap gap-2"><Button variant="app-primary" type="button" disabled={!draftValid || save.isPending} onClick={() => void savePlan()}>{save.isPending ? m.common_loading() : draft.id ? m.race_plan_save_changes() : m.race_plan_save()}</Button>{draft.id && savedCombo && <Button variant="app-outline" type="button" disabled={save.isPending || activate.isPending} onClick={() => activate.mutate({ ...savedCombo, planId: null }, { onSuccess: () => setNotice(m.race_plan_unloaded()), onError: () => setError(m.race_plan_save_error()) })}>{m.race_plan_unload()}</Button>}</div>
        {!draftValid && <p className="text-app-detail text-status-warning">{draftSourcesValid ? m.race_plan_invalid() : m.race_plan_source_unavailable()}</p>}{error && <p role="alert" className="text-app-detail text-status-danger">{error} <Button variant="app-ghost" type="button" onClick={() => { if (retryAction) void savePlan(); else setError(null); }}>{retryAction ? m.race_plan_retry() : m.race_plan_draft_retained()}</Button></p>}{notice && <p role="status" className="text-app-detail text-app-text-muted">{notice}</p>}
      </div>
  </section>;
}
