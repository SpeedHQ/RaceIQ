import type { FourWheels, MetricRate, PitEstimateRecord, StintSummary } from "@raceiq/shared/racing/live/strategy";
import type { AdherenceCheckpoint, AdherencePoint, AdherenceResource, AdaptivePitWindow, BuildStrategyAdherence, BuildStrategyAdherenceInput, ResolveAdherenceCheckpoints, ResolveAdherenceCheckpointsInput, StrategyAdherenceModel } from "../contracts/strategy-adherence";
import { supportsRaceRefueling } from "../contracts/race-rules";

const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const wearValue = (value: unknown): value is number => nonnegative(value) && value <= 1;
function rateValue(rate: MetricRate | undefined, unit: MetricRate["unit"]): number | null {
  return rate && rate.value !== null && nonnegative(rate.value) && rate.unit === unit ? rate.value : null;
}
function emptyResource(): AdherenceResource {
  return { state: "unknown", basis: "unknown", plannedRate: null, observedRate: null, eligibleLaps: 0, actual: [], reference: [] };
}
function makeWindow(reason: AdaptivePitWindow["reason"] = "evidence"): AdaptivePitWindow {
  return { state: "unknown", earliestLap: null, latestLap: null, stopsRemaining: null, limitedBy: null, basis: "unknown", reason };
}

export const resolveAdherenceCheckpoints: ResolveAdherenceCheckpoints = (input: ResolveAdherenceCheckpointsInput) => {
  const { plan, sessionId, driverKey, stintId } = input;
  if (sessionId === null || !driverKey || !stintId) return [];
  const lapNumbers = new Map<number, number>();
  for (const lap of input.laps) {
    if (lap.sessionId === sessionId && Number.isSafeInteger(lap.id) && Number.isInteger(lap.lapNumber) && lap.lapNumber > 0) lapNumbers.set(lap.id, lap.lapNumber);
  }
  const latest = new Map<number, PitEstimateRecord>();
  for (const record of input.estimates) {
    if (record.trigger !== "lap-completed") continue;
    const lap = record.sourceSnapshot.lapId === null ? undefined : lapNumbers.get(record.sourceSnapshot.lapId);
    if (record.sessionId !== sessionId || record.driverKey !== driverKey || record.stintId !== stintId || record.gameId !== plan.gameId ||
      record.carId !== plan.carId || record.trackId !== plan.trackId || (plan.gameId === "fm-2023" && (plan.pi === null || record.pi !== plan.pi)) ||
      lap === undefined || !Number.isSafeInteger(record.sourceOrder.epochOrdinal) || !Number.isSafeInteger(record.sourceOrder.sequence)) continue;
    const previous = latest.get(lap);
    if (!previous || record.sourceOrder.epochOrdinal > previous.sourceOrder.epochOrdinal ||
      record.sourceOrder.epochOrdinal === previous.sourceOrder.epochOrdinal && record.sourceOrder.sequence >= previous.sourceOrder.sequence) latest.set(lap, record);
  }
  const ordered = [...latest.entries()].sort((a, b) => a[0] - b[0]);
  const result: AdherenceCheckpoint[] = [];
  for (const [lap, record] of ordered) {
    const snapshot = record.sourceSnapshot;
    const fuelRemaining = snapshot.fuelUnit === plan.fuelUnit && nonnegative(snapshot.fuelRemaining) ? snapshot.fuelRemaining : null;
    const tireWear = snapshot.wear.map((value) => wearValue(value) ? value : null) as FourWheels<number | null>;
    const compounds = record.compounds.map((value) => typeof value === "string" && value.length > 0 ? value : null) as FourWheels<string | null>;
    result.push({ lap, fuelRemaining, tireWear, compounds });
  }
  return result;
};

type Series = { actual: AdherencePoint[]; reference: AdherencePoint[] };
function buildSeries(checkpoints: readonly AdherenceCheckpoint[], metric: "fuel" | number, current: number | null,
  planned: number | null, currentPosition: number | null, horizon: number | null): Series {
  const actual: AdherencePoint[] = [];
  let prior: number | null = null;
  let priorLap: number | null = null;
  let breakPending = false;
  let anchor: AdherenceCheckpoint | null = null;
  for (const checkpoint of checkpoints) {
    const value = metric === "fuel" ? checkpoint.fuelRemaining : checkpoint.tireWear[metric];
    if (!nonnegative(value) || (metric !== "fuel" && value > 1)) {
      breakPending = true;
      continue;
    }
    const reset = prior !== null && (metric === "fuel" ? value > prior + 1e-9 : value < prior - 1e-9);
    const gap = priorLap !== null && checkpoint.lap !== priorLap + 1;
    const breakBefore = actual.length > 0 && (breakPending || reset || gap);
    actual.push({ lap: checkpoint.lap, value, breakBefore });
    if (!anchor || reset) anchor = checkpoint;
    prior = value;
    priorLap = checkpoint.lap;
    breakPending = false;
  }
  if (current !== null && currentPosition !== null) {
    const last = actual[actual.length - 1];
    if (last?.lap === currentPosition) {
      const reset = metric === "fuel" ? current > last.value + 1e-9 : current < last.value - 1e-9;
      actual[actual.length - 1] = { lap: currentPosition, value: current, breakBefore: last.breakBefore || reset };
      if (reset) anchor = { lap: currentPosition, fuelRemaining: metric === "fuel" ? current : null,
        tireWear: (metric === "fuel" ? [null, null, null, null] : [0, 1, 2, 3].map((wheel) => wheel === metric ? current : null)) as FourWheels<number | null>,
        compounds: checkpoints[checkpoints.length - 1]?.compounds ?? [null, null, null, null] as FourWheels<string | null> };
    }
    else {
      const latestCheckpoint = checkpoints[checkpoints.length - 1];
      const reset = last !== undefined && (metric === "fuel" ? current > last.value + 1e-9 : current < last.value - 1e-9);
      actual.push({ lap: currentPosition, value: current, breakBefore: actual.length > 0 && (breakPending || reset || Math.floor(currentPosition) !== last?.lap) });
      if (reset) anchor = { lap: currentPosition, fuelRemaining: metric === "fuel" ? current : null,
        tireWear: (metric === "fuel" ? [null, null, null, null] : [0, 1, 2, 3].map((wheel) => wheel === metric ? current : null)) as FourWheels<number | null>,
        compounds: latestCheckpoint?.compounds ?? [null, null, null, null] as FourWheels<string | null> };
      else if (!anchor) anchor = { lap: currentPosition, fuelRemaining: metric === "fuel" ? current : null,
        tireWear: (metric === "fuel" ? [null, null, null, null] : [0, 1, 2, 3].map((wheel) => wheel === metric ? current : null)) as FourWheels<number | null>,
        compounds: latestCheckpoint?.compounds ?? [null, null, null, null] as FourWheels<string | null> };
    }
  }
  const reference: AdherencePoint[] = [];
  if (planned !== null && anchor) {
    const anchorValue = metric === "fuel" ? anchor.fuelRemaining : anchor.tireWear[metric];
    if (nonnegative(anchorValue)) {
      reference.push({ lap: anchor.lap, value: anchorValue, breakBefore: false });
      if (horizon !== null && horizon > anchor.lap) {
        const distanceToLimit = planned === 0 ? Infinity : metric === "fuel" ? anchorValue / planned : (1 - anchorValue) / planned;
        const end = Math.min(horizon, anchor.lap + distanceToLimit);
        if (Number.isFinite(end) && end > anchor.lap) {
          const projected = metric === "fuel" ? Math.max(0, anchorValue - planned * (end - anchor.lap)) :
            Math.min(1, anchorValue + planned * (end - anchor.lap));
          if (Number.isFinite(projected)) reference.push({ lap: end, value: projected, breakBefore: false });
        } else if (end === Infinity) reference.push({ lap: horizon, value: anchorValue, breakBefore: false });
      }
    }
  }
  return { actual, reference };
}
function makeMetricResource(checkpoints: readonly AdherenceCheckpoint[], metric: "fuel" | number, current: number | null,
  planned: number | null, observed: number | null, eligible: number, position: number | null, horizon: number | null,
  actualLimit: number | null, overAtOrBeyondLimit: boolean): AdherenceResource {
  const series = buildSeries(checkpoints, metric, current, planned, position, horizon);
  const eligibleCurrent = observed !== null && eligible >= 2 ? eligible : 0;
  const positionValid = current !== null && position !== null;
  const rateValid = eligibleCurrent >= 2 && planned !== null;
  const exhausted = positionValid && actualLimit !== null && (overAtOrBeyondLimit ? current! >= actualLimit : current! <= actualLimit);
  // Float32 tire levels introduce rate noise; keep forecasts unrounded.
  const rateTolerance = metric === "fuel" ? 1e-9 : 1e-7;
  const state = !positionValid ? "unknown" : exhausted ? "over" : !rateValid ? "unknown" : observed! > planned! + rateTolerance ? "over" : "within";
  return { state, basis: eligibleCurrent >= 2 ? "measured" : planned !== null ? "plan" : "unknown", plannedRate: planned,
    observedRate: eligibleCurrent >= 2 ? observed : null, eligibleLaps: eligibleCurrent, actual: series.actual, reference: series.reference };
}

export const buildStrategyAdherence: BuildStrategyAdherence = (input: BuildStrategyAdherenceInput): StrategyAdherenceModel => {
  const { plan, currentStint, strategy } = input;
  const matches = !!currentStint && !!strategy && currentStint.sessionId === strategy.sessionId && currentStint.driverKey === strategy.driverKey &&
    currentStint.id === strategy.stintId && currentStint.gameId === plan.gameId && currentStint.carId === plan.carId && currentStint.trackId === plan.trackId &&
    (plan.gameId !== "fm-2023" || (plan.pi !== null && currentStint.pi === plan.pi));
  const compatible = (evidence: StintSummary) => evidence.gameId === plan.gameId && evidence.carId === plan.carId && evidence.trackId === plan.trackId &&
    (plan.gameId !== "fm-2023" || evidence.pi === plan.pi);
  const evidence = matches ? plan.stints.map((stint) => stint.evidence).filter((item): item is StintSummary => !!item && compatible(item)) : [];
  const usesFuel = supportsRaceRefueling(plan.gameId);
  const referenceStint = plan.stints.find((stint) => input.currentLap !== null && input.currentLap <= stint.endLap)?.evidence;
  const fuelUnit = plan.fuelUnit === "L" ? "L/lap" : "tankFraction/lap";
  const fuelCandidates = evidence.filter((item) => item.fuelUnit === plan.fuelUnit && item.compatibility.fuelSemanticVersion !== null &&
    item.compatibility.fuelSemanticVersion === currentStint?.compatibility.fuelSemanticVersion).map((item) => rateValue(item.fuel, fuelUnit)).filter((value): value is number => value !== null);
  const referenceFuel = referenceStint && compatible(referenceStint) && referenceStint.fuelUnit === plan.fuelUnit &&
    referenceStint.compatibility.fuelSemanticVersion !== null && referenceStint.compatibility.fuelSemanticVersion === currentStint?.compatibility.fuelSemanticVersion
    ? rateValue(referenceStint.fuel, fuelUnit) : null;
  const plannedFuel = usesFuel ? referenceFuel ?? (fuelCandidates.length > 0 && fuelCandidates.every((value) => value === fuelCandidates[0]) ? fuelCandidates[0]! : null) : null;
  const physicalCapacity = nonnegative(input.fuelCapacity) && input.fuelCapacity > 0 ? input.fuelCapacity : null;
  const liveFuelValid = input.fuelUnit === plan.fuelUnit && currentStint?.fuelUnit === plan.fuelUnit && nonnegative(input.fuelRemaining) &&
    (physicalCapacity === null || input.fuelRemaining! <= physicalCapacity);
  const liveFuel = liveFuelValid ? input.fuelRemaining : null;
  const lapValid = Number.isInteger(input.currentLap) && input.currentLap! > 0 && nonnegative(input.lapFraction) && input.lapFraction! < 1;
  const position = lapValid ? input.currentLap! - 1 + input.lapFraction! : null;
  const checkpoints = input.checkpoints.filter((checkpoint) => input.currentLap === null || checkpoint.lap < input.currentLap);
  const historyObserved = strategy?.fuel.source === "current-stint" && strategy.fuel.eligibleLaps >= 2 && strategy.fuel.unit === fuelUnit && currentStint?.fuelUnit === plan.fuelUnit
    ? rateValue(strategy.fuel, fuelUnit) : null;
  const horizon = position === null ? null : plan.totalLaps;
  const fuel = makeMetricResource(checkpoints, "fuel", matches ? liveFuel : null, plannedFuel, historyObserved,
    strategy?.fuel.eligibleLaps ?? 0, position, horizon, plan.generation?.fuelReserve ?? null, false);
  const tires = [0, 1, 2, 3].map((wheel) => {
    const compound = currentStint?.compounds[wheel];
    const semantic = currentStint?.compatibility.tireSemanticVersions[wheel];
    const candidates = compound === null || compound === undefined || semantic == null ? [] : evidence.filter((item) => item.compounds[wheel] === compound &&
      item.compatibility.tireSemanticVersions[wheel] !== null && item.compatibility.tireSemanticVersions[wheel] === semantic)
      .map((item) => rateValue(item.tires[wheel], "wearFraction/lap")).filter((value): value is number => value !== null);
    const preferred = referenceStint && compatible(referenceStint) && referenceStint.compounds[wheel] === compound && semantic != null &&
      referenceStint.compatibility.tireSemanticVersions[wheel] === semantic ? rateValue(referenceStint.tires[wheel], "wearFraction/lap") : null;
    const planned = preferred ?? (candidates.length > 0 && candidates.every((value) => value === candidates[0]) ? candidates[0]! : null);
    const current = wearValue(input.tireWear[wheel]) ? input.tireWear[wheel] : null;
    const live = strategy && strategy.tires[wheel].source === "current-stint" && strategy.tires[wheel].eligibleLaps >= 2 && strategy.tires[wheel].unit === "wearFraction/lap"
      ? rateValue(strategy.tires[wheel], "wearFraction/lap") : null;
    const cliff = input.thresholds[wheel]?.cliffPct;
    const limit = Number.isFinite(cliff) && cliff! >= 0 && cliff! < 100 ? 1 - cliff! / 100 : null;
    return makeMetricResource(checkpoints.filter((checkpoint) => checkpoint.compounds[wheel] === compound), wheel, matches ? current : null, planned, live,
      strategy?.tires[wheel].eligibleLaps ?? 0, position, horizon, limit, true);
  }) as FourWheels<AdherenceResource>;
  const energyCompatible = currentStint?.compatibility.virtualEnergySemanticVersion != null && evidence.some((item) =>
    item.compatibility.virtualEnergySemanticVersion != null && item.compatibility.virtualEnergySemanticVersion === currentStint.compatibility.virtualEnergySemanticVersion &&
    item.virtualEnergy?.unit === "energyFraction/lap" && nonnegative(item.virtualEnergy.value));
  const energyEvidence = evidence.filter((item) => item.compatibility.virtualEnergySemanticVersion != null &&
    item.compatibility.virtualEnergySemanticVersion === currentStint?.compatibility.virtualEnergySemanticVersion)
    .map((item) => rateValue(item.virtualEnergy, "energyFraction/lap")).filter((value): value is number => value !== null);
  const energyReference = referenceStint && compatible(referenceStint) && currentStint?.compatibility.virtualEnergySemanticVersion != null &&
    referenceStint.compatibility.virtualEnergySemanticVersion === currentStint.compatibility.virtualEnergySemanticVersion
    ? rateValue(referenceStint.virtualEnergy, "energyFraction/lap") : null;
  const energyPlan = energyReference ?? (energyCompatible && energyEvidence.length && energyEvidence.every((value) => value === energyEvidence[0]) ? energyEvidence[0]! : null);
  const energyLive = currentStint?.virtualEnergy?.source === "current-stint" && currentStint.virtualEnergy.eligibleLaps >= 2
    ? rateValue(currentStint.virtualEnergy, "energyFraction/lap") : null;

  const windowResources = usesFuel ? [fuel, ...tires] : tires;
  const knownOver = matches && windowResources.some((item) => item.state === "over");
  const allWithin = windowResources.every((item) => item.state === "within");
  let window = makeWindow(input.evidenceError ? "history" : position === null ? "position" : "settings");
  const settings = plan.generation ?? { fuelCapacity: 0, fuelReserve: 0, energyReserveFraction: 0 };
  if (matches && position !== null && (plan.generation != null || !usesFuel)) {
    const energyGame = plan.gameId === "lmu";
    const futureFuelRate = historyObserved ?? plannedFuel;
    const futureTireRates = tires.map((item) => item.observedRate ?? item.plannedRate);
    const currentRanges: { laps: number; limiter: "fuel" | "tires" | "energy" }[] = [];
    const addRange = (value: number | null, limit: number, rate: number | null, limiter: "fuel" | "tires" | "energy") => {
      if (value === null || rate === null) return;
      currentRanges.push({ laps: rate === 0 ? (limiter === "tires" ? value >= limit ? 0 : Infinity : value <= limit ? 0 : Infinity) :
        (limiter === "tires" ? (limit - value) / rate : (value - limit) / rate), limiter });
    };
    if (usesFuel) addRange(liveFuel, settings.fuelReserve, futureFuelRate, "fuel");
    for (let wheel = 0; wheel < 4; wheel++) {
      const cliff = input.thresholds[wheel]?.cliffPct;
      if (Number.isFinite(cliff) && cliff! >= 0 && cliff! < 100) addRange(wearValue(input.tireWear[wheel]) ? input.tireWear[wheel] : null,
        1 - cliff! / 100, futureTireRates[wheel] ?? null, "tires");
    }
    const energyRate = energyLive ?? energyPlan;
    if (energyGame) addRange(wearValue(input.virtualEnergy) ? input.virtualEnergy : null, settings.energyReserveFraction, energyRate, "energy");
    const missing = (usesFuel && !liveFuelValid) || input.tireWear.some((value) => !wearValue(value)) ? "evidence" :
      usesFuel && futureFuelRate === null ? "evidence" : futureTireRates.some((rate) => rate === null) ? "compound" :
      energyGame && (!nonnegative(input.virtualEnergy) || input.virtualEnergy! > 1 || energyRate === null) ? "energy" :
      usesFuel && physicalCapacity !== null && settings.fuelCapacity > physicalCapacity ? "capacity" : null;
    if (position >= plan.totalLaps) {
      const measured = (!usesFuel || historyObserved !== null) && tires.every((item) => item.observedRate !== null) && (!energyGame || energyLive !== null);
      window = { state: "finish", earliestLap: null, latestLap: null, stopsRemaining: 0, limitedBy: null, basis: measured ? "measured" : "plan", reason: null };
    } else if (missing) window = makeWindow(missing);
    else if (currentRanges.length === (usesFuel ? 5 : 4) + (energyGame ? 1 : 0)) {
      const limiting = currentRanges.reduce((a, b) => a.laps <= b.laps ? a : b);
      const future: number[] = [];
      if (usesFuel) future.push(futureFuelRate === 0 ? Infinity : futureFuelRate === null ? NaN : (settings.fuelCapacity - settings.fuelReserve) / futureFuelRate);
      for (let wheel = 0; wheel < 4; wheel++) {
        const rate = futureTireRates[wheel];
        const cliff = input.thresholds[wheel]?.cliffPct;
        future.push(rate === 0 ? Infinity : rate === null || !Number.isFinite(cliff) ? NaN : (1 - cliff! / 100) / rate);
      }
      if (energyGame) future.push(energyRate === 0 ? Infinity : energyRate === null ? NaN : (1 - settings.energyReserveFraction) / energyRate);
      const fullRange = Math.min(...future);
      const distance = Math.max(0, plan.totalLaps - position);
      if (position >= plan.totalLaps || limiting.laps >= distance) {
        window = { state: "finish", earliestLap: null, latestLap: null, stopsRemaining: 0, limitedBy: limiting.limiter,
          basis: (!usesFuel || historyObserved !== null) && tires.every((item) => item.observedRate !== null) && (!energyGame || energyLive !== null) ? "measured" : "plan", reason: null };
      } else if (limiting.laps <= 0) {
        window = { ...makeWindow("infeasible"), state: "overdue", earliestLap: input.currentLap, latestLap: input.currentLap, limitedBy: limiting.limiter };
      } else if (Number.isNaN(fullRange) || fullRange <= 0) window = makeWindow("infeasible");
      else {
        const stops = fullRange === Infinity ? 1 : Math.ceil((distance - limiting.laps) / fullRange);
        const earliest = fullRange === Infinity ? input.currentLap! : Math.max(input.currentLap!, Math.ceil(plan.totalLaps - stops * fullRange - 1e-9));
        const latest = Math.min(plan.totalLaps - 1, Math.floor(position + limiting.laps + 1e-9));
        window = stops > 100 || latest < input.currentLap! || earliest > latest ?
          { ...makeWindow("infeasible"), state: latest < input.currentLap! ? "overdue" : "unknown", limitedBy: limiting.limiter } : {
            state: input.currentLap! < earliest ? "upcoming" : "open", earliestLap: earliest, latestLap: latest, stopsRemaining: stops,
            limitedBy: limiting.limiter,
            basis: (!usesFuel || historyObserved !== null) && tires.every((item) => item.observedRate !== null) && (!energyGame || energyLive !== null) ? "measured" : "plan", reason: null,
          };
      }
    }
  }
  const usableEvidence = matches && (!usesFuel || liveFuelValid) && input.tireWear.every(wearValue) && position !== null && strategy?.persistence === "ok" &&
    !input.evidenceLoading && !input.evidenceError && window.state !== "unknown" && window.basis === "measured";
  const state: StrategyAdherenceModel["state"] = knownOver ? "over" : allWithin && usableEvidence ? "within" : "unknown";
  const plannedStopLaps = plan.stints.slice(0, -1).map((stint) => stint.endLap);
  return { state, currentPosition: position, plannedStopLaps, fuel: matches ? fuel : emptyResource(),
    tires: matches ? tires : [emptyResource(), emptyResource(), emptyResource(), emptyResource()], window };
};
