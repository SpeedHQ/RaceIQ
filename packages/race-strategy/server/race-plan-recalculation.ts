import { supportsRaceRefueling } from "../contracts/race-rules";
import { client } from "@raceiq/backend-core/db/index";
import { getTireThresholdOverrides } from "@raceiq/backend-core/runtime/config/settings";
import { withSessionCaptureMaintenanceLock } from "@raceiq/backend-core/session-capture/cleanup";
import { isRecordingSession } from "@raceiq/backend-core/telemetry/live-pipeline";
import { getTireThresholds } from "@raceiq/shared/racing/live/tire-thresholds";
import { RacePlanRecalculationInputSchema, RacePlanInputSchema, RacePlanSchema, type RacePlan, type RacePlanInput, estimateRaceLaps } from "@raceiq/shared/racing/live/race-plan";
import { StintSummarySchema } from "@raceiq/shared/racing/live/strategy-schemas";
import type { StintSummary } from "@raceiq/shared/racing/live/strategy";
import type { RacePlanBaseline } from "@raceiq/shared/racing/live/race-plan";
import { aggregateRacePlanEvidence } from "@raceiq/shared/racing/live/race-plan-evidence";
import { InvalidRacePlanError, RacePlanNotFoundError } from "./race-plan-queries";
import { generateRacePlanStints } from "../contracts/generate-race-plan";

export class RacePlanEvidenceUnavailableError extends Error {}
function timestamp(value: string): number {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  return Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`);
}

async function recalculateRacePlanUnlocked(id: string, value: unknown) {
  const request = RacePlanRecalculationInputSchema.safeParse(value);
  if (!request.success) throw new InvalidRacePlanError();
  const plans = await client.execute({ sql: "SELECT payload FROM race_plans WHERE id = ?", args: [id] });
  const payload = plans.rows[0]?.payload;
  if (payload == null) throw new RacePlanNotFoundError();
  let saved: RacePlan;
  try { saved = RacePlanSchema.parse(JSON.parse(String(payload))); }
  catch { throw new InvalidRacePlanError(); }
  if (saved.fuelUnit === "tankFraction" && request.data.generation.fuelCapacity > 1) throw new InvalidRacePlanError();
  const raceLength = saved.raceLength ?? { mode: "laps" };
  const hasAggregate = saved.stints.some((stint) => stint.baseline);
  const sessionResult = await client.execute({
    sql: `SELECT s.id FROM sessions s WHERE s.game_id=? AND s.car_id=? AND s.track_id=? AND s.ownership='mine'
      AND (NOT EXISTS (SELECT 1 FROM live_captures c WHERE c.session_id=s.id)
        OR EXISTS (SELECT 1 FROM live_captures c WHERE c.session_id=s.id AND c.status='sealed'))
      ORDER BY s.created_at DESC,s.id DESC`,
    args: [saved.gameId, saved.carId, saved.trackId],
  });
  const recentSessionIds = new Set(sessionResult.rows.filter((row) => !isRecordingSession(Number(row.id))).slice(0, 5).map((row) => Number(row.id)));
  if (hasAggregate && !recentSessionIds.size) throw new RacePlanEvidenceUnavailableError();
  const result = await client.execute({
    sql: `SELECT s.id, s.session_id, s.payload, s.driver_key, s.ordinal, s.status, se.created_at, se.ownership, se.game_id, se.car_id, se.track_id
      FROM strategy_stints s JOIN sessions se ON se.id=s.session_id
      WHERE se.game_id=? AND se.car_id=? AND se.track_id=? AND se.ownership='mine'
        AND (NOT EXISTS (SELECT 1 FROM live_captures c WHERE c.session_id=se.id)
          OR EXISTS (SELECT 1 FROM live_captures c WHERE c.session_id=se.id AND c.status='sealed'))
        AND s.driver_key='local-player' AND s.status IN ('completed','interrupted')
      ORDER BY se.created_at DESC,se.id DESC,s.ordinal DESC,s.id ASC`,
    args: [saved.gameId, saved.carId, saved.trackId],
  });
  const candidates: { summary: StintSummary; createdAt: number; endedAt: number }[] = [];
  for (const row of result.rows) {
    try {
      const summary = StintSummarySchema.parse(JSON.parse(String(row.payload)));
      if (isRecordingSession(summary.sessionId)) continue;
      const createdAt = timestamp(String(row.created_at));
      const endedAt = timestamp(summary.endedAt ?? "");
      if (!Number.isFinite(createdAt) || !Number.isFinite(endedAt) ||
          summary.id !== String(row.id) || summary.sessionId !== Number(row.session_id) ||
          summary.status !== row.status || summary.driverKey !== row.driver_key ||
          summary.status === "active" || summary.driverKey !== "local-player" ||
          summary.gameId !== saved.gameId || summary.carId !== saved.carId || summary.trackId !== saved.trackId ||
          summary.fuelUnit !== saved.fuelUnit || summary.pi !== saved.pi ||
          saved.gameId === "fm-2023" && (saved.pi === null || summary.pi === null) ||
          summary.compounds.some((compound) => compound == null) ||
          summary.fuel.value == null || summary.fuel.eligibleLaps < 1 || summary.fuel.value < 0 ||
          summary.fuel.unit !== (saved.fuelUnit === "L" ? "L/lap" : "tankFraction/lap") ||
          summary.tires.some((rate) => rate.value == null || rate.eligibleLaps < 1 || rate.value < 0 || rate.unit !== "wearFraction/lap") ||
          summary.averageLapSeconds == null || summary.averageLapSeconds <= 0 || summary.paceLaps < 1 ||
          saved.gameId === "lmu" && (!summary.virtualEnergy || summary.virtualEnergy.value == null || summary.virtualEnergy.value < 0 || summary.virtualEnergy.eligibleLaps < 1 || summary.virtualEnergy.unit !== "energyFraction/lap")) continue;
      candidates.push({ summary, createdAt, endedAt });
    } catch { /* malformed or mismatched historical evidence is ineligible */ }
  }
  candidates.sort((a, b) => b.createdAt - a.createdAt || b.summary.sessionId - a.summary.sessionId ||
    b.endedAt - a.endedAt || b.summary.ordinal - a.summary.ordinal || a.summary.id.localeCompare(b.summary.id));
  if (!candidates.length && !hasAggregate) throw new RacePlanEvidenceUnavailableError();

  const { generation } = request.data;
  const phases: { compound: StintSummary["compounds"]; originalLaps: number; source: StintSummary | RacePlanBaseline }[] = [];
  const picked: StintSummary[] = [];
  let previousCompound: StintSummary["compounds"] | null = null;
  let previousEnd = 0;
  for (const old of saved.stints) {
    if (previousCompound && previousCompound.every((compound, index) => compound === old.compounds[index])) {
      phases.at(-1)!.originalLaps += old.endLap - previousEnd;
      previousEnd = old.endLap;
      continue;
    }
    const originalPhase = old.baseline ?? old.evidence;
    if (!originalPhase) throw new RacePlanEvidenceUnavailableError();
    const knownSemantics = originalPhase.compatibility.fuelSemanticVersion !== null &&
      originalPhase.compatibility.tireSemanticVersions.every((version) => version !== null) &&
      (saved.gameId !== "lmu" || originalPhase.compatibility.virtualEnergySemanticVersion != null);
    const matching = candidates.filter((item) => (!old.baseline || recentSessionIds.has(item.summary.sessionId)) &&
      item.summary.compounds.every((compound, index) => compound === old.compounds[index]) &&
      item.summary.pi === saved.pi && item.summary.fuelUnit === saved.fuelUnit &&
      item.summary.compatibility.setupKey === originalPhase.compatibility.setupKey &&
      item.summary.compatibility.fuelSemanticVersion === originalPhase.compatibility.fuelSemanticVersion &&
      item.summary.compatibility.tireSemanticVersions.every((version, index) => version !== null && version === originalPhase.compatibility.tireSemanticVersions[index]) &&
      (saved.gameId !== "lmu" || item.summary.compatibility.virtualEnergySemanticVersion !== null &&
        item.summary.compatibility.virtualEnergySemanticVersion === originalPhase.compatibility.virtualEnergySemanticVersion));
    const refreshed = old.baseline && knownSemantics
      ? aggregateRacePlanEvidence(matching.slice(0, 100).map((item) => item.summary), saved.weather ?? "any") ?? undefined : undefined;
    const match = old.baseline ? undefined : knownSemantics ? matching[0] : undefined;
    const source = old.baseline ? refreshed : match?.summary;
    if (!source) throw new RacePlanEvidenceUnavailableError();
    phases.push({ compound: [...old.compounds] as StintSummary["compounds"], originalLaps: old.endLap - previousEnd, source });
    if (old.baseline) {
      for (const summary of refreshed!.sources) if (!picked.some((item) => item.id === summary.id && item.sessionId === summary.sessionId)) picked.push(summary);
    } else if (match && !picked.some((item) => item.id === match.summary.id)) picked.push(match.summary);
    previousCompound = [...old.compounds] as StintSummary["compounds"];
    previousEnd = old.endLap;
  }
  if (!phases.length) throw new RacePlanEvidenceUnavailableError();
  const originalLaps = phases.reduce((sum, phase) => sum + phase.originalLaps, 0);
  const weightedPace = phases.every((phase) => phase.source.averageLapSeconds !== null)
    ? phases.reduce((sum, phase) => sum + phase.originalLaps * phase.source.averageLapSeconds!, 0) / originalLaps : null;
  const totalLaps = raceLength.mode === "time" && weightedPace !== null ? estimateRaceLaps(raceLength.durationSeconds, weightedPace) :
    raceLength.mode === "time" ? null : saved.totalLaps;
  if (!totalLaps || totalLaps <= phases.slice(0, -1).reduce((sum, phase) => sum + phase.originalLaps, 0)) {
    throw new RacePlanEvidenceUnavailableError();
  }
  const thresholds = (compound: string) => getTireThresholds(getTireThresholdOverrides(), saved.gameId, compound);
  const stints = [] as RacePlanInput["stints"];
  let phaseStart = 0;
  const supportsRefueling = supportsRaceRefueling(saved.gameId);
  let remainingInitialFuel = generation.fuelCapacity;
  for (let index = 0; index < phases.length; index++) {
    const phase = phases[index]!;
    const phaseEnd = index < phases.length - 1 ? phaseStart + phase.originalLaps : totalLaps;
    if (phaseEnd <= phaseStart || phaseEnd > totalLaps) throw new RacePlanEvidenceUnavailableError();
    const adjustedFuel = supportsRefueling ? generation.fuelCapacity : remainingInitialFuel;
    const generated = generateRacePlanStints(phase.source, phaseEnd - phaseStart, adjustedFuel, generation.fuelReserve, thresholds, generation.energyReserveFraction);
    if (!generated) throw new RacePlanEvidenceUnavailableError();
    for (const stint of generated) stints.push({ ...stint, endLap: stint.endLap + phaseStart, compounds: [...phase.compound] });
    if (!supportsRefueling) remainingInitialFuel -= (phaseEnd - phaseStart) * phase.source.fuel.value!;
    phaseStart = phaseEnd;
  }
  if (stints.length > 100 || stints.at(-1)?.endLap !== totalLaps) throw new RacePlanEvidenceUnavailableError();
  const draft = RacePlanInputSchema.parse({ name: saved.name, gameId: saved.gameId, carId: saved.carId, trackId: saved.trackId, pi: saved.pi,
    totalLaps, raceLength: raceLength.mode === "time" && weightedPace !== null ? { ...raceLength, averageLapSeconds: weightedPace } : raceLength,
    weather: saved.weather ?? "any", fuelUnit: saved.fuelUnit, notes: saved.notes, generation, stints });
  return { draft, sources: picked };
}

export function recalculateRacePlan(id: string, value: unknown) {
  return withSessionCaptureMaintenanceLock(() => recalculateRacePlanUnlocked(id, value));
}
