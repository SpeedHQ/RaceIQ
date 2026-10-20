import type { MetricRate } from "@raceiq/shared/racing/live/strategy";
import { isStrategyHistoryCurrent, useStrategyBaseline, useStrategyHistoryRevision } from "@/hooks/stint-strategy";
import { GameIdSchema } from "@raceiq/shared/games/ids";
import type { GameId } from "@raceiq/shared/games/ids";
import { getGame } from "@raceiq/shared/games/registry"
import { getFuelDisplay } from "@raceiq/shared/games/telemetry"
import { hasTireHealthData, hasTireHealthDataSemantic, resolveAnalysisTelemetry } from "@raceiq/shared/racing/analysis/telemetry-capabilities"
import { severityColor } from "@/lib/colors";
import { tireHealthPctColor } from "@/lib/vehicle-dynamics";
import { m } from "@/paraglide/messages";
import type { LiveTelemetryView } from "@/lib/live-telemetry-view";
import type { LivePitData } from "@raceiq/shared/racing/live/types";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { useTelemetryStore } from "@/stores/telemetry";
import { PitWindow } from "./PitWindow";
import { StrategyHistory } from "./StrategyHistory";
import { strategyRateText } from "@/lib/strategy-format";

interface PitEstimateProps {
  packet?: TelemetryPacket;
  view?: LiveTelemetryView;
  pit: LivePitData | null;
}


function rateText(rate: MetricRate) {
  return `${strategyRateText(rate)} · ${m.strategy_eligible_laps({ count: rate.eligibleLaps })}`;
}

function StrategyEvidence({ metric, source, provisional, baseline, sessionId, gameId, unavailableReason }: { metric: "fuel" | "fl" | "fr" | "rl" | "rr"; source: "history" | "current-stint" | null; provisional: boolean; baseline: NonNullable<NonNullable<LivePitData["strategy"]>["baseline"]> | null; sessionId: number; gameId: GameId; unavailableReason: string | null }) {
  if (!source) return <span className="text-app-text-dim">{unavailableReason === "history-refresh-pending" ? m.strategy_refresh_pending() : m.strategy_gathering()}</span>;
  if (source === "current-stint") return <span className="text-app-text-muted">{m.strategy_current_stint()}{provisional && ` · ${m.race_result_provisional()}`}</span>;
  const evidence = baseline?.evidence.filter((item) => item.metric === metric) ?? [];
  const sessions = [...new Set(evidence.map((item) => item.sessionId))];
  const label = sessions.includes(sessionId) ? sessions.length > 1 ? m.strategy_mixed_history() : m.strategy_earlier_stints() : m.strategy_previous_sessions();
  const lastObservedAt = evidence.reduce<string | null>((latest, item) => latest == null || item.endedAt > latest ? item.endedAt : latest, null);
  return <span className="text-app-text-muted">{label} · {m.strategy_evidence_counts({ sessions: sessions.length, stints: new Set(evidence.map((item) => item.stintId)).size, laps: evidence.reduce((sum, item) => sum + item.eligibleLaps, 0) })} · {m.strategy_last_observed({ time: lastObservedAt ? new Date(lastObservedAt).toLocaleString() : m.strategy_unknown() })}{baseline?.limitations.includes("unknown-setup-key") && ` · ${m.strategy_setup_uncertain()}`} {evidence.map((item) => <a key={`${item.sessionId}:${item.stintId}`} className="ml-1 underline" href={`/${getGame(gameId).routePrefix}/sessions/${item.sessionId}/analyse#stint-${encodeURIComponent(item.stintId)}`}>{m.strategy_evidence_link({ session: item.sessionId, stint: item.stintId })}</a>)}</span>;
}
/**
 * PitEstimate — Displays server-computed fuel and tire estimates.
 * All computation happens server-side in PitTracker; this component just renders.
 */
export function PitEstimate({ packet, view, pit }: PitEstimateProps) {
  const serverStatus = useTelemetryStore((state) => state.serverStatus);
  const gameCandidate = view?.simulator ?? packet?.gameId ?? serverStatus?.detectedGame?.id;
  const gameId = GameIdSchema.safeParse(gameCandidate).success ? gameCandidate as GameId : null;
  const sessionId = pit?.strategy?.sessionId ?? serverStatus?.currentSession?.id ?? null;
  const receivedStrategy = pit?.strategy ?? null;
  const requiredRevision = useStrategyHistoryRevision(gameId, receivedStrategy?.driverKey ?? null);
  const historyDriverKey = receivedStrategy?.driverKey ?? null;
  const baselineQuery = useStrategyBaseline(gameId, receivedStrategy?.sessionId ?? null, receivedStrategy?.stintId ?? null, historyDriverKey);
  const queriedBaseline = baselineQuery.data?.baseline;
  const receivedRevisionCurrent = !receivedStrategy || receivedStrategy.historyRevision >= Math.max(requiredRevision, queriedBaseline?.historyRevision ?? -1);
  const queriedRevisionCurrent = gameId != null && historyDriverKey != null && queriedBaseline != null && queriedBaseline.historyRevision >= (receivedStrategy?.historyRevision ?? -1) && isStrategyHistoryCurrent(gameId, historyDriverKey, queriedBaseline.historyRevision);
  const historyCurrent = receivedRevisionCurrent || queriedRevisionCurrent;
  const baseline = queriedRevisionCurrent ? queriedBaseline! : receivedStrategy?.baseline ?? null;
  const trustedStrategy = receivedStrategy ? {
    ...receivedStrategy,
    baseline: historyCurrent ? baseline : null,
    fuel: receivedStrategy.fuel.source === "history" && queriedRevisionCurrent ? queriedBaseline?.fuel ?? receivedStrategy.fuel : receivedStrategy.fuel,
    tires: receivedStrategy.tires.map((rate, index) => rate.source === "history" && queriedRevisionCurrent ? queriedBaseline?.tires[index] ?? rate : rate) as typeof receivedStrategy.tires,
  } : null;
  const visibleStrategy = trustedStrategy && !historyCurrent ? {
    ...trustedStrategy,
    baseline: null,
    fuel: trustedStrategy.fuel.source === "history" ? { ...trustedStrategy.fuel, value: null, source: null, unavailableReason: "history-refresh-pending" } : trustedStrategy.fuel,
    tires: trustedStrategy.tires.map((rate) => rate.source === "history" ? { ...rate, value: null, source: null, unavailableReason: "history-refresh-pending" } : rate) as typeof trustedStrategy.tires,
  } : trustedStrategy;
  const strategy = visibleStrategy;
  if (!gameId) return null;
  const adapter = getGame(gameId);
  const telemetryModel = adapter.telemetry;
  const analysis = resolveAnalysisTelemetry(adapter);
  const wears = view?.tires.wear ? [view.tires.wear.fl, view.tires.wear.fr, view.tires.wear.rl, view.tires.wear.rr] : [packet?.TireWearFL ?? Number.NaN, packet?.TireWearFR ?? Number.NaN, packet?.TireWearRL ?? Number.NaN, packet?.TireWearRR ?? Number.NaN];
  const healthAvailable = view ? hasTireHealthDataSemantic(wears, analysis.tireHealth) : packet != null && hasTireHealthData(packet, analysis.tireHealth);
  const rawFuel = view ? view.fuel.amount : packet?.Fuel;
  const fuelAvailable = rawFuel != null && Number.isFinite(rawFuel) && rawFuel >= 0 && (telemetryModel.fuel.packetUnit !== "fraction" || rawFuel <= 1);
  const fuel = getFuelDisplay({ Fuel: rawFuel ?? Number.NaN, FuelCapacity: view?.fuel.capacity ?? packet?.FuelCapacity }, telemetryModel.fuel);
  const fuelPct = !fuelAvailable || fuel.fillRatio === undefined || !Number.isFinite(fuel.fillRatio) ? undefined : fuel.fillRatio * 100;
  const isFuelCritical = fuelAvailable && (fuel.fillRatio === undefined ? fuel.amount < 5 : fuel.fillRatio < 0.2);
  const isFuelWarning = fuelAvailable && !isFuelCritical && (fuel.fillRatio === undefined ? fuel.amount < 15 : fuel.fillRatio < 0.4);
  const fuelColor = fuelAvailable ? severityColor(isFuelCritical ? 3 : isFuelWarning ? 1 : 0) : "var(--app-text-dim)";

  const fuelLaps = !fuelAvailable || !receivedRevisionCurrent && receivedStrategy?.fuel.source === "history" ? null : pit?.fuelLapsRemaining ?? null;
  const tireLabels = ["FL", "FR", "RL", "RR"] as const;
  // Per-tire display
  const tireData = tireLabels.map((label, i) => {
    const health = healthAvailable && Number.isFinite(wears[i]) && wears[i] >= 0 && wears[i] <= 1 ? (1 - wears[i]) * 100 : null;
    const canEstimateWear = analysis.tireWearRate.source !== "unavailable";
    const wearRate = strategy ? strategy.tires[i]?.value ?? null : canEstimateWear ? pit?.tireEstimates?.wearPerLap[i] ?? null : null;
    const staleProjection = !receivedRevisionCurrent && receivedStrategy?.tires[i]?.source === "history";
    return {
      label,
      health,
      healthColor: health === null ? "var(--status-unavailable)" : tireHealthPctColor(health),
      toCliff: canEstimateWear && !staleProjection ? (pit?.tireEstimates?.toCliff[i] ?? null) : null,
      toDead: canEstimateWear && !staleProjection ? (pit?.tireEstimates?.toDead[i] ?? null) : null,
      wearPerLap: wearRate == null ? null : (wearRate * 100).toFixed(1),
    };
  });

  const pitStatus = telemetryModel.pitStatus ? (view?.competitors[0]?.pitStatus ?? packet?.acc?.pitStatus ?? (packet?.iracing?.onPitRoad || packet?.lmu?.inPits ? "pit_lane" : "out")) : undefined;
  const pitBadge = pitStatus === "in_pit" ? { label: m.pit_in_pit(), color: "var(--status-info)" } : pitStatus === "pit_lane" ? { label: m.pit_pit_lane(), color: "var(--status-warning)" } : null;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        {pitBadge ? (
          <span
            className="text-xs font-bold px-2 py-0.5 rounded border tracking-widest uppercase bg-(--pit-badge-color)/20 border-(--pit-badge-color)/30 text-(--pit-badge-color)"
            style={{ ["--pit-badge-color" as string]: pitBadge.color }}
          >
            {pitBadge.label}
          </span>
        ) : (
          <span />
        )}
        <PitWindow pit={!receivedRevisionCurrent && (receivedStrategy?.fuel.source === "history" || receivedStrategy?.tires.some((rate) => rate.source === "history")) ? null : pit} />
      </div>
      <div className="space-y-3">
        {/* Fuel row */}
        <div className="py-1">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-app-text-muted uppercase tracking-wider font-semibold">{m.telemetry_fuel()}</div>
            <div className="text-lg font-mono font-bold tabular-nums" style={{ color: fuelLaps != null ? fuelColor : "var(--app-text-dim)" }}>
              {fuelLaps != null ? `~${fuelLaps.toFixed(1)} ${m.gauges_laps_left()}` : "—"}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {fuelPct === undefined ? (
              <div className="flex-1 h-3 rounded-full border border-dashed border-app-border" title={m.pit_fuel_capacity_unavailable()} />
            ) : (
              <div className="flex-1 h-3 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ backgroundColor: fuelColor, width: `${fuelPct}%` }} />
              </div>
            )}
            <div className={`text-2xl font-mono font-black tabular-nums leading-none ${fuel.unit === "L" ? "w-20" : "w-14"} text-right`} style={{ color: fuelColor }}>
              {fuelAvailable ? fuel.amount.toFixed(fuel.unit === "L" ? 1 : 0) : "—"}
              {fuel.unit}
            </div>
          </div>
          {strategy && (
            <p data-testid="strategy-live-evidence" className="mt-1 text-xs leading-4 text-app-text-muted">
              {rateText(strategy.fuel)} · <StrategyEvidence metric="fuel" source={strategy.fuel.source} provisional={strategy.fuel.provisional} baseline={strategy.baseline} sessionId={strategy.sessionId} gameId={gameId} unavailableReason={strategy.fuel.unavailableReason} />
            </p>
          )}
        </div>

        {/* Tire section */}
        <div className="py-1">
          <div className="text-xs text-app-text-muted uppercase tracking-wider font-semibold mb-2">
            {analysis.tireHealth.source === "direct" && analysis.tireHealth.freshness === "pit-snapshot" ? m.analyse_wheels_pit_health() : m.label_tires()}
          </div>

          {/* Column headers */}
          <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-x-2 items-center mb-1 px-0.5">
            <div className="w-6" />
            <div />
            <div className="text-app-caption text-app-text-dim uppercase tracking-wider text-right w-12">{m.pit_health()}</div>
            <div className="text-app-caption text-app-text-dim uppercase tracking-wider text-right w-14">{m.pit_wear_lap()}</div>
            <div className="text-app-caption uppercase tracking-wider text-right w-12 text-(--severity-caution)/70">
              {m.pit_cliff()}
              {pit?.cliffPct ? ` ${pit.cliffPct}%` : ""}
            </div>
            <div className="text-app-caption uppercase tracking-wider text-right w-12 text-(--severity-critical)/70">
              {m.pit_dead()}
              {pit?.deadPct ? ` ${pit.deadPct}%` : ""}
            </div>
          </div>
          {tireData.map((t) => (
            <div key={t.label} className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-x-2 items-center py-1.5 px-0.5">
              <div className="text-sm font-bold text-app-text-muted w-6">{t.label}</div>
              <div className="h-3 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ backgroundColor: t.healthColor, width: t.health === null ? 0 : `${t.health}%` }} />
              </div>
              <div className="text-lg font-mono font-black tabular-nums leading-none text-right w-12" style={{ color: t.healthColor }}>
                {t.health === null ? "—" : `${t.health.toFixed(0)}%`}
              </div>
              <div className={`text-sm font-mono font-bold tabular-nums leading-none text-right w-14 ${t.wearPerLap ? "text-app-text-secondary" : "text-app-text-dim"}`}>
                {t.wearPerLap ? `${t.wearPerLap}%` : "—"}
              </div>
              <div className="text-lg font-mono font-bold tabular-nums leading-none text-right w-12" style={{ color: t.toCliff != null ? "var(--severity-caution)" : "var(--app-text-dim)" }}>
                {t.toCliff != null ? t.toCliff.toFixed(1) : "—"}
              </div>
              <div className="text-lg font-mono font-bold tabular-nums leading-none text-right w-12" style={{ color: t.toDead != null ? "var(--severity-critical)" : "var(--app-text-dim)" }}>
                {t.toDead != null ? t.toDead.toFixed(1) : "—"}
              </div>
            </div>
          ))}
          {strategy && (
            <div data-testid="strategy-tire-evidence" className="mt-2 space-y-1 text-xs leading-4">
              {strategy.tires.map((rate, index) => {
                const metric = (["fl", "fr", "rl", "rr"] as const)[index]!;
                return <p key={metric}>{metric.toUpperCase()}: {analysis.tireWearRate.source === "unavailable" ? m.strategy_reason_unsupported() : <>{rateText(rate)} · <StrategyEvidence metric={metric} source={rate.source} provisional={rate.provisional} baseline={strategy.baseline} sessionId={strategy.sessionId} gameId={gameId} unavailableReason={rate.unavailableReason} /></>}</p>;
              })}
            </div>
          )}
          {strategy?.persistence === "error" && <p data-testid="strategy-persistence-error" role="status" className="text-xs text-status-warning">{m.strategy_persistence_error()}</p>}
          {baselineQuery.isError && <p role="alert" className="text-xs text-status-danger">{m.common_error()}: {m.strategy_historical_evidence()} <button type="button" className="underline" onClick={() => void baselineQuery.refetch()}>{m.strategy_retry()}</button></p>}
          <StrategyHistory key={`${gameId}:${sessionId}`} gameId={gameId} currentSessionId={sessionId} defaultDriverKey={historyDriverKey} />
        </div>
      </div>
    </div>
  );
}
