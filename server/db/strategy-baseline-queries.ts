import type { InValue } from "@libsql/client";
import { StintSummarySchema } from "@raceiq/shared/racing/live/strategy-schemas";
import type { HistoricalBaseline, MetricRate, StintSummary } from "@raceiq/shared/racing/live/strategy";
import { client } from "./index";
import { z } from "zod";

const TotalsSchema = z.record(z.string(), z.unknown());

/** Compatibility and eligibility are filtered in SQLite before the shared latest-20 bound. */
export async function getStrategyBaseline(target: StintSummary): Promise<HistoricalBaseline> {
  const tx = await client.transaction("read");
  try {
    const args: InValue[] = [target.gameId, target.driverKey, target.trackId, target.carId, target.id, target.compatibility.setupKey];
    let piFilter = "";
    if (target.gameId === "fm-2023") {
      piFilter = "AND json_extract(s.payload, '$.pi') = ?";
      args.push(target.pi);
    }
    const predicates: string[] = [];
    const fuelVersion = target.compatibility.fuelSemanticVersion;
    if (fuelVersion != null) {
      predicates.push("(json_extract(s.payload, '$.fuelUnit') = ? AND json_extract(s.payload, '$.compatibility.fuelSemanticVersion') = ? AND json_extract(s.payload, '$.fuel.eligibleLaps') > 0)");
      args.push(target.fuelUnit, fuelVersion);
    }
    for (let wheel = 0; wheel < 4; wheel++) {
      const version = target.compatibility.tireSemanticVersions[wheel];
      if (version == null) continue;
      predicates.push(`(json_extract(s.payload, '$.compatibility.tireSemanticVersions[${wheel}]') = ? AND json_extract(s.payload, '$.compounds[${wheel}]') IS ? AND json_extract(s.payload, '$.tires[${wheel}].eligibleLaps') > 0)`);
      args.push(version, target.compounds[wheel]);
    }
    const result = await tx.execute({
      sql: `SELECT s.payload, s.totals FROM strategy_stints s JOIN sessions ON sessions.id = s.session_id
        WHERE sessions.game_id = ? AND sessions.ownership = 'mine' AND s.driver_key = ?
          AND sessions.track_id = ? AND sessions.car_id = ? AND s.id != ?
          AND json_extract(s.payload, '$.compatibility.setupKey') IS ? ${piFilter}
          AND s.status IN ('completed','interrupted') AND json_extract(s.payload, '$.endedAt') IS NOT NULL
          AND (${predicates.join(" OR ") || "0"})
        ORDER BY json_extract(s.payload, '$.endedAt') DESC, s.id DESC LIMIT 20`, args,
    });
    const sources = result.rows.map((row) => ({ summary: StintSummarySchema.parse(JSON.parse(String(row.payload))), totals: TotalsSchema.parse(JSON.parse(String(row.totals))) }));
    const revision = await tx.execute({ sql: "SELECT revision FROM strategy_history_revisions WHERE game_id = ? AND driver_key = ?", args: [target.gameId, target.driverKey] });
    const evidence: HistoricalBaseline["evidence"] = [];
    const metric = (wheel: number | null): MetricRate => {
      const fuel = wheel == null;
      const version = fuel ? target.compatibility.fuelSemanticVersion : target.compatibility.tireSemanticVersions[wheel];
      let sum = 0;
      let count = 0;
      if (version != null) for (const { summary: source, totals } of sources) {
        const comparable = fuel ? source.fuelUnit === target.fuelUnit && source.compatibility.fuelSemanticVersion === version
          : source.compounds[wheel] === target.compounds[wheel] && source.compatibility.tireSemanticVersions[wheel] === version;
        const rate = fuel ? source.fuel : source.tires[wheel];
        if (!comparable || rate.value == null || rate.eligibleLaps === 0) continue;
        const numerator = totals[fuel ? "fuel" : `tire${wheel}`];
        if (typeof numerator !== "number" || !Number.isFinite(numerator)) continue;
        sum += numerator;
        count += rate.eligibleLaps;
        evidence.push({ metric: fuel ? "fuel" : (["fl", "fr", "rl", "rr"] as const)[wheel], sessionId: source.sessionId, stintId: source.id, eligibleLaps: rate.eligibleLaps, endedAt: source.endedAt! });
      }
      return { value: count > 0 ? sum / count : null, unit: fuel ? target.fuelUnit === "L" ? "L/lap" : "tankFraction/lap" : "wearFraction/lap", eligibleLaps: count, source: count > 0 ? "history" : null, provisional: false, unavailableReason: count > 0 ? null : "no-compatible-history" };
    };
    const fuel = metric(null);
    const tires: HistoricalBaseline["tires"] = [metric(0), metric(1), metric(2), metric(3)];
    const limitations: string[] = [];
    if (target.compatibility.setupKey == null) limitations.push("unknown-setup-key");
    if (target.compounds.some((compound) => compound == null)) limitations.push("unknown-tire-compound");
    if (target.compatibility.fuelSemanticVersion == null) limitations.push("unknown-fuel-semantic-version");
    if (target.compatibility.tireSemanticVersions.some((version) => version == null)) limitations.push("unknown-tire-semantic-version");
    const baseline: HistoricalBaseline = { fuel, tires, evidence, lastObservedAt: evidence.reduce<string | null>((latest, entry) => latest == null || entry.endedAt > latest ? entry.endedAt : latest, null), limitations, historyRevision: Number(revision.rows[0]?.revision ?? 0) };
    await tx.commit();
    return baseline;
  } catch (error) { await tx.rollback(); throw error; }
}
