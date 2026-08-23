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

export interface OpponentPaceTrackerOptionsV1 {
  recentLapCount?: number;
  withinPercent?: number;
  offPercent?: number;
  outlierPercent?: number;
  cooldownMs?: number;
}
export type OpponentPaceRelation = "fastest-in-class" | "setting-race-pace" | "within-class-pace" | "off-class-pace" | "outlier-lap";
export interface OpponentPaceCandidateV1 {
  candidateId: string;
  decisionId: string;
  relation: OpponentPaceRelation;
  priority: "high" | "normal" | "low";
  benchmarkFactId: string;
  benchmarkLapTimeMs: number;
  player: PlayerLapForPaceV1;
  deltaMs: number;
  deltaPercent: number;
}

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
    if (!(this.options.offPercent > this.options.withinPercent && this.options.outlierPercent > this.options.offPercent)) throw new Error("pace thresholds must increase");
  }
  reset(timelineEpoch = this.timelineEpoch + 1): void { this.timelineEpoch = timelineEpoch; this.facts.clear(); this.emitted.clear(); this.lastByParticipant.clear(); }
  addFact(fact: OpponentLapFactV1): boolean {
    if (fact.timelineEpoch !== this.timelineEpoch || !fact.valid || !finitePositive(fact.lapNumber) || !finitePositive(fact.lapTimeMs) || !fact.classId || this.facts.has(fact.factId)) return false;
    const last = this.lastByParticipant.get(fact.participantId);
    if (last !== undefined && fact.lapNumber <= last) return false;
    this.lastByParticipant.set(fact.participantId, fact.lapNumber); this.facts.set(fact.factId, fact); return true;
  }
  factsForClass(classId: string): OpponentLapFactV1[] { return [...this.facts.values()].filter((f) => f.classId === classId).sort((a, b) => a.completedSessionTimeMs - b.completedSessionTimeMs); }
  createCandidate(player: PlayerLapForPaceV1): OpponentPaceCandidateV1 | null {
    if (player.timelineEpoch !== this.timelineEpoch || !finitePositive(player.lapNumber) || !finitePositive(player.lapTimeMs) || player.inPit || player.caution) return null;
    const facts = this.factsForClass(player.classId); if (!facts.length) return null;
    const race = RACE.has(player.sessionType.toLowerCase()); let benchmark: OpponentLapFactV1 | undefined;
    if (!race) benchmark = [...facts].sort((a, b) => a.lapTimeMs - b.lapTimeMs)[0];
    else {
      const byParticipant = new Map<string, OpponentLapFactV1[]>(); for (const fact of facts) { const list = byParticipant.get(fact.participantId) ?? []; list.push(fact); byParticipant.set(fact.participantId, list.slice(-this.options.recentLapCount)); }
      const medians = [...byParticipant.values()].filter((list) => list.length >= this.options.recentLapCount).map((list) => ({ time: median(list.map((f) => f.lapTimeMs)), fact: list[list.length - 1]! }));
      benchmark = medians.sort((a, b) => a.time - b.time)[0]?.fact;
    }
    if (!benchmark) return null;
    const sampleTimes = facts.length >= 5 ? facts.filter((f) => Math.abs(f.lapTimeMs - median(facts.map((x) => x.lapTimeMs))) / median(facts.map((x) => x.lapTimeMs)) <= 0.15).map((f) => f.lapTimeMs) : facts.map((f) => f.lapTimeMs);
    if (!sampleTimes.length) return null;
    const benchmarkLapTimeMs = race ? benchmark.lapTimeMs : Math.min(...sampleTimes); const deltaMs = player.lapTimeMs - benchmarkLapTimeMs; const deltaPercent = 100 * deltaMs / benchmarkLapTimeMs;
    let relation: OpponentPaceRelation;
    if (deltaPercent < -0.1) relation = "fastest-in-class"; else if (race && Math.abs(deltaPercent) <= 0.1) relation = "setting-race-pace"; else if (deltaPercent <= this.options.withinPercent) relation = "within-class-pace"; else if (deltaPercent <= this.options.outlierPercent) relation = "off-class-pace"; else relation = "outlier-lap";
    const candidateId = `${player.sessionId}/${player.timelineEpoch}/${player.lapNumber}/${relation}/${benchmark.factId}`;
    if (this.emitted.has(candidateId)) return null; this.emitted.add(candidateId);
    const priority = relation === "fastest-in-class" || relation === "outlier-lap" ? "high" : relation === "within-class-pace" ? "low" : "normal";
    return { candidateId, decisionId: `${candidateId}/opponent-pace-v1`, relation, priority, benchmarkFactId: benchmark.factId, benchmarkLapTimeMs, player, deltaMs, deltaPercent };
  }
}
