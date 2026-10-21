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
import { PitEstimateDialog } from "./PitEstimateDialog";
import { strategyRateText } from "@/lib/strategy-format";
import { useActiveRacePlan } from "@/hooks/race-plans";
import { isRacePlanApplicable } from "@/lib/race-plan-projection";
import { CompactRaceStrategy } from "./LiveRaceStrategy";

interface PitEstimateProps {
  packet?: TelemetryPacket;
  view?: LiveTelemetryView;
  pit: LivePitData | null;
}


/**
 * PitEstimate — Displays server-computed fuel and tire estimates.
 * All computation happens server-side in PitTracker; this component just renders.
 */
export function PitEstimate({ packet, view, pit }: PitEstimateProps) {
  const serverStatus = useTelemetryStore((state) => state.serverStatus);
  const activePlanQuery = useActiveRacePlan();
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
  const fuelCapacity = view?.fuel.capacity ?? packet?.FuelCapacity;
  const hasFuelCapacity = fuelCapacity != null && Number.isFinite(fuelCapacity) && fuelCapacity > 0;
  const alternateFuel = !fuelAvailable ? null : fuel.unit === "%"
    ? hasFuelCapacity ? `${(rawFuel! * fuelCapacity).toFixed(1)} L` : null
    : fuel.fillRatio != null ? `${(fuel.fillRatio * 100).toFixed(0)}%` : null;
  const isFuelCritical = fuelAvailable && (fuel.fillRatio === undefined ? fuel.amount < 5 : fuel.fillRatio < 0.2);
  const isFuelWarning = fuelAvailable && !isFuelCritical && (fuel.fillRatio === undefined ? fuel.amount < 15 : fuel.fillRatio < 0.4);
  const fuelColor = fuelAvailable ? severityColor(isFuelCritical ? 3 : isFuelWarning ? 1 : 0) : "var(--app-text-dim)";

  const tireLabels = ["FL", "FR", "RL", "RR"] as const;
  const tireData = tireLabels.map((label, i) => {
    const health = healthAvailable && Number.isFinite(wears[i]) && wears[i] >= 0 && wears[i] <= 1 ? (1 - wears[i]) * 100 : null;
    const canEstimateWear = analysis.tireWearRate.source !== "unavailable";
    const wearRate = strategy ? strategy.tires[i]?.value ?? null : canEstimateWear ? pit?.tireEstimates?.wearPerLap[i] ?? null : null;
    const staleProjection = !receivedRevisionCurrent && receivedStrategy?.tires[i]?.source === "history";
    const thresholds = pit?.tireThresholds?.[i];
    return {
      label,
      health,
      healthColor: health === null ? "var(--status-unavailable)" : tireHealthPctColor(health),
      toCliff: canEstimateWear && !staleProjection ? (pit?.tireEstimates?.toCliff[i] ?? null) : null,
      toDead: canEstimateWear && !staleProjection ? (pit?.tireEstimates?.toDead[i] ?? null) : null,
      wearPerLap: wearRate == null ? null : (wearRate * 100).toFixed(1),
      cliffPct: thresholds?.cliffPct ?? pit?.cliffPct ?? null,
      deadPct: thresholds?.deadPct ?? pit?.deadPct ?? null,
    };
  });
  const thresholdText = (label: string, values: (number | null)[]) => {
    const present = values.filter((value): value is number => value != null && Number.isFinite(value));
    const unique = [...new Set(present)];
    return present.length === values.length && unique.length === 1
      ? `${label} ${unique[0]}%`
      : `${label} ${present.length ? m.pit_mixed_thresholds() : "—"}`;
  };
  const cliffHeader = thresholdText(m.pit_cliff(), tireData.map((tire) => tire.cliffPct));
  const deadHeader = thresholdText(m.pit_dead(), tireData.map((tire) => tire.deadPct));
  const projectionPit = !receivedRevisionCurrent && (receivedStrategy?.fuel.source === "history" || receivedStrategy?.tires.some((rate) => rate.source === "history")) ? null : pit;
  const dialogPit = projectionPit && !fuelAvailable
    ? { ...projectionPit, fuelLapsRemaining: null, ...(projectionPit.limitedBy === "fuel" ? { pitInLaps: null, limitedBy: null } : {}) }
    : projectionPit;

  const pitStatus = telemetryModel.pitStatus ? (view?.competitors[0]?.pitStatus ?? packet?.acc?.pitStatus ?? (packet?.iracing?.onPitRoad || packet?.lmu?.inPits ? "pit_lane" : "out")) : undefined;
  const pitBadge = pitStatus === "in_pit" ? { label: m.pit_in_pit(), color: "var(--status-info)" } : pitStatus === "pit_lane" ? { label: m.pit_pit_lane(), color: "var(--status-warning)" } : null;

  const currentLap = view?.timing.lapNumber ?? packet?.LapNumber ?? null;
  const selectedPlan = activePlanQuery.data?.plan ?? null;
  const activePlan = !activePlanQuery.isError && isRacePlanApplicable(selectedPlan, {
    gameId, carId: view?.identity.carId ?? packet?.carId ?? null,
    trackId: view?.identity.trackId ?? packet?.trackId ?? null,
    pi: view?.identity.performanceIndex ?? packet?.CarPerformanceIndex ?? null,
  }) ? selectedPlan : null;
  const strategyFuelRate = strategy?.fuel;
  const fuelRate = fuelAvailable && strategyFuelRate?.value != null
    ? strategyRateText(strategyFuelRate)
    : fuelAvailable && !strategy && pit && Number.isFinite(pit.fuelPerLap) && pit.fuelPerLap > 0
      ? fuel.unit === "L"
        ? m.strategy_rate_litres({ value: pit.fuelPerLap.toFixed(2) })
        : m.strategy_rate_points({ value: (pit.fuelPerLap * 100).toFixed(1) })
      : "—";

  return (
    <section data-testid={activePlan ? "race-strategy-live" : "pit-estimate-live"} className="min-w-0 text-sm">
      <header className="flex min-h-8 items-center justify-between gap-2 border-b border-app-border px-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-app-text-muted">{activePlan ? m.race_plan_title() : m.label_pit_window()}{pitBadge && <span className="ml-2" style={{ color: pitBadge.color }}>{pitBadge.label}</span>}</h3>
        <PitEstimateDialog
          gameId={gameId}
          sessionId={sessionId}
          currentLap={currentLap}
          carId={view?.identity.carId ?? packet?.carId ?? null}
          trackId={view?.identity.trackId ?? packet?.trackId ?? null}
          pi={view?.identity.performanceIndex ?? packet?.CarPerformanceIndex ?? null}
          pit={dialogPit}
          fuelAmount={fuelAvailable ? fuel.amount : null}
          fuelUnit={fuel.unit}
          strategy={strategy}
          tires={tireData}
          historyDriverKey={historyDriverKey}
        />
      </header>
      <div className="space-y-2 p-3">
      {activePlan ? <CompactRaceStrategy plan={activePlan} currentLap={currentLap} /> : <>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3">
        <div className="min-w-0">
          <p className="mb-1 text-xs text-app-text-muted">{m.pit_timeline_estimate_current()}</p>
          <PitWindow pit={dialogPit} />
        </div>
        <div className="min-w-0 text-right">
          <p className="font-mono text-xl font-bold tabular-nums" style={{ color: fuelColor }}>
            {fuelAvailable ? fuel.amount.toFixed(fuel.unit === "L" ? 1 : 0) : "—"}<span className="ml-1 text-xs font-normal text-app-text-muted">{fuel.unit}</span>
            {alternateFuel && <span className="ml-2 text-sm font-semibold text-app-text-secondary">{alternateFuel}</span>}
          </p>
          <p className="text-xs text-app-text-muted">{m.pit_timeline_fuel_remaining()}</p>
          <p className="mt-1 font-mono text-sm font-bold tabular-nums text-app-text-secondary">{fuelRate}</p>
        </div>
      </div>
      <div>
        <table className="w-full table-fixed text-xs">
          <thead className="text-app-text-muted">
            <tr className="border-b border-app-border">
              <th scope="col" className="w-10 py-1 text-left font-normal">{m.pit_timeline_corner()}</th>
              <th scope="col" className="py-1 text-right font-normal">{m.pit_wear_lap()}</th>
              <th scope="col" className="py-1 text-right font-normal">{m.tune_tire()} {cliffHeader}<span className="block text-app-text-dim">{m.pitwindow_laps()}</span></th>
              <th scope="col" className="py-1 text-right font-normal">{m.tune_tire()} {deadHeader}<span className="block text-app-text-dim">{m.pitwindow_laps()}</span></th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {tireData.map((tire) => (
              <tr key={tire.label} className="border-b border-app-border/50 last:border-0">
                <th scope="row" className="py-1 text-left font-semibold">{tire.label}</th>
                <td className="py-1 text-right">{tire.wearPerLap == null ? "—" : `${tire.wearPerLap}%`}</td>
                <td className="py-1 text-right text-(--severity-caution)">{tire.toCliff == null ? "—" : tire.toCliff.toFixed(1)}</td>
                <td className="py-1 text-right text-(--severity-critical)">{tire.toDead == null ? "—" : tire.toDead.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>}
      </div>
    </section>
  );
}
