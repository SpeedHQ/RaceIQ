export type OpponentFactSourceQualityV1 = "native-validity" | "conservative-inference";
export interface OpponentLapFactV1 {
  factId: string;
  gameId: string;
  sessionId: string;
  timelineEpoch: number;
  participantId: string;
  participantName: string;
  classId: string;
  className?: string;
  lapNumber: number;
  lapTimeMs: number;
  sectorTimesMs?: readonly number[];
  valid: true;
  inPit: boolean;
  completedSessionTimeMs: number;
  sourceSequence: number;
  sourceQuality: OpponentFactSourceQualityV1;
}
export interface PlayerLapForPaceV1 {
  sessionId: string;
  timelineEpoch: number;
  lapNumber: number;
  lapTimeMs: number;
  classId: string;
  className?: string;
  sessionType: "practice" | "qualifying" | "race" | "hotlap" | string;
  completedSessionTimeMs: number;
  sourceSequence: number;
  inPit?: boolean;
  caution?: boolean;
}
export interface OpponentPaceTrackerOptionsV1 { recentLapCount?: number; withinPercent?: number; offPercent?: number; outlierPercent?: number; cooldownMs?: number; }
export type OpponentPaceRelation = "fastest-in-class" | "setting-race-pace" | "within-class-pace" | "off-class-pace" | "outlier-lap";
export interface OpponentPaceCandidateV1 { candidateId: string; decisionId: string; relation: OpponentPaceRelation; priority: "high" | "normal" | "low"; benchmarkFactId: string; benchmarkLapTimeMs: number; player: PlayerLapForPaceV1; deltaMs: number; deltaPercent: number; }

const RACE = new Set(["race", "race_1", "race_2", "multiplayer_race"]);
const finitePositive = (n: number): boolean => Number.isFinite(n) && Number.isInteger(n) && n > 0;
const median = (values: readonly number[]): number => { const a = [...values].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]!; };

export class OpponentPaceTracker {
  private readonly facts = new Map<string, OpponentLapFactV1>();
  private readonly emitted = new Set<string>();
  private readonly lastByParticipant = new Map<string, number>();
  private readonly options: Required<OpponentPaceTrackerOptionsV1>;
  private timelineEpoch = 0;
  constructor(options: OpponentPaceTrackerOptionsV1 = {}) {
    this.options = { recentLapCount: options.recentLapCount ?? 3, withinPercent: options.withinPercent ?? 0.3, offPercent: options.offPercent ?? 1, outlierPercent: options.outlierPercent ?? 5, cooldownMs: options.cooldownMs ?? 60_000 };
    if (this.options.recentLapCount < 2 || this.options.recentLapCount > 5 || this.options.offPercent <= this.options.withinPercent || this.options.outlierPercent <= this.options.offPercent) throw new Error("invalid pace policy thresholds");
  }
  reset(timelineEpoch = this.timelineEpoch + 1): void { this.timelineEpoch = timelineEpoch; this.facts.clear(); this.emitted.clear(); this.lastByParticipant.clear(); }
  addFact(fact: OpponentLapFactV1): boolean {
    if (fact.timelineEpoch !== this.timelineEpoch || !fact.valid || !finitePositive(fact.lapNumber) || !finitePositive(fact.lapTimeMs) || !fact.classId || fact.inPit || this.facts.has(fact.factId)) return false;
    const last = this.lastByParticipant.get(fact.participantId); if (last !== undefined && fact.lapNumber <= last) return false;
    this.lastByParticipant.set(fact.participantId, fact.lapNumber); this.facts.set(fact.factId, fact); return true;
  }
  factsForClass(classId: string): OpponentLapFactV1[] { return [...this.facts.values()].filter((f) => f.classId === classId).sort((a, b) => a.completedSessionTimeMs - b.completedSessionTimeMs); }
  createCandidate(player: PlayerLapForPaceV1): OpponentPaceCandidateV1 | null {
    if (player.timelineEpoch !== this.timelineEpoch || !finitePositive(player.lapNumber) || !finitePositive(player.lapTimeMs) || player.inPit || player.caution) return null;
    const facts = this.factsForClass(player.classId); if (!facts.length) return null;
    const race = RACE.has(player.sessionType.toLowerCase());
    const eligible = this.robustSamples(facts);
    if (!eligible.length) return null;
    let benchmarkFact: OpponentLapFactV1 | undefined;
    let benchmarkLapTimeMs: number;
    if (!race) { benchmarkFact = [...eligible].sort((a, b) => a.lapTimeMs - b.lapTimeMs)[0]; if (!benchmarkFact) return null; benchmarkLapTimeMs = benchmarkFact.lapTimeMs; }
    else {
      const byParticipant = new Map<string, OpponentLapFactV1[]>();
      for (const fact of eligible) { const list = byParticipant.get(fact.participantId) ?? []; list.push(fact); byParticipant.set(fact.participantId, list.slice(-this.options.recentLapCount)); }
      const medians = [...byParticipant.entries()].map(([participantId, list]) => list.length >= this.options.recentLapCount ? { participantId, list, time: median(list.map((f) => f.lapTimeMs)) } : null).filter((x): x is { participantId: string; list: OpponentLapFactV1[]; time: number } => x !== null).sort((a, b) => a.time - b.time);
      const fastest = medians[0]; if (!fastest) return null;
      benchmarkLapTimeMs = fastest.time; benchmarkFact = fastest.list[fastest.list.length - 1];
    }
    const deltaMs = player.lapTimeMs - benchmarkLapTimeMs; const deltaPercent = 100 * deltaMs / benchmarkLapTimeMs;
    let relation: OpponentPaceRelation;
    if (deltaPercent < -0.1) relation = "fastest-in-class"; else if (race && Math.abs(deltaPercent) <= 0.1) relation = "setting-race-pace"; else if (deltaPercent <= this.options.withinPercent) relation = "within-class-pace"; else if (deltaPercent <= this.options.outlierPercent) relation = "off-class-pace"; else relation = "outlier-lap";
    const candidateId = `${player.sessionId}/${player.timelineEpoch}/${player.lapNumber}/${relation}/${benchmarkFact.factId}`;
    if (this.emitted.has(candidateId)) return null; this.emitted.add(candidateId);
    const priority = relation === "fastest-in-class" || relation === "outlier-lap" ? "high" : relation === "within-class-pace" ? "low" : "normal";
    return { candidateId, decisionId: `${candidateId}/opponent-pace-v1`, relation, priority, benchmarkFactId: benchmarkFact.factId, benchmarkLapTimeMs, player, deltaMs, deltaPercent };
  }
  private robustSamples(facts: OpponentLapFactV1[]): OpponentLapFactV1[] {
    if (facts.length < 5) return facts;
    const center = median(facts.map((f) => f.lapTimeMs));
    const deviations = facts.map((f) => Math.abs(f.lapTimeMs - center));
    const mad = median(deviations);
    return facts.filter((f) => Math.abs(f.lapTimeMs - center) / center <= 0.15 && (mad === 0 || Math.abs(f.lapTimeMs - center) <= 4 * mad));
  }
}
