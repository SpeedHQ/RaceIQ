import type { LiveEngineerCandidateV1, LiveEngineerDecisionReasonV1 } from "../../shared/racing/live/engineer-contracts";

export interface LiveEngineerRuntimeCandidate extends LiveEngineerCandidateV1 {
  sessionId: string;
  timelineEpoch: number;
  sourceSequence: number;
  priority: "high" | "normal" | "low";
  createdSessionTimeMs: number;
  expiresSessionTimeMs: number;
}
export interface LiveEngineerDecisionV1 { candidateId: string; decisionId: string; reason: LiveEngineerDecisionReasonV1; decidedSessionTimeMs: number; }
export interface LiveEngineerRuntimeOptionsV1 {
  now?: () => number;
  maxQueue?: number;
  cooldownMs?: number;
  onDecision?: (decision: LiveEngineerDecisionV1) => void;
  onSelected?: (candidate: LiveEngineerRuntimeCandidate) => void;
  revalidate?: (candidate: LiveEngineerRuntimeCandidate) => boolean;
}
const RANK = { high: 0, normal: 1, low: 2 } as const;

export class LiveEngineerRuntime {
  private readonly now: () => number;
  private readonly maxQueue: number;
  private readonly cooldownMs: number;
  private readonly onDecision?: (decision: LiveEngineerDecisionV1) => void;
  private readonly onSelected?: (candidate: LiveEngineerRuntimeCandidate) => void;
  private readonly revalidate: (candidate: LiveEngineerRuntimeCandidate) => boolean;
  private readonly queue: LiveEngineerRuntimeCandidate[] = [];
  private readonly semantic = new Set<string>();
  private readonly cooldown = new Map<string, number>();
  private readonly recent: LiveEngineerDecisionV1[] = [];
  private currentSession: string | undefined;
  private currentEpoch = 0;
  constructor(options: LiveEngineerRuntimeOptionsV1 = {}) {
    this.now = options.now ?? (() => Date.now()); this.maxQueue = options.maxQueue ?? 3; this.cooldownMs = options.cooldownMs ?? 60_000;
    this.onDecision = options.onDecision; this.onSelected = options.onSelected; this.revalidate = options.revalidate ?? (() => true);
  }
  reset(sessionId?: string, timelineEpoch = this.currentEpoch + 1): void { this.queue.length = 0; this.semantic.clear(); this.cooldown.clear(); this.currentSession = sessionId; this.currentEpoch = timelineEpoch; }
  submit(candidate: LiveEngineerRuntimeCandidate): LiveEngineerDecisionV1 {
    const now = this.now(); this.prune(now);
    const make = (reason: LiveEngineerDecisionReasonV1): LiveEngineerDecisionV1 => { const d = { candidateId: candidate.candidateId, decisionId: `${candidate.candidateId}/${candidate.policyVersion}`, reason, decidedSessionTimeMs: now }; this.recent.push(d); this.recent.splice(0, Math.max(0, this.recent.length - 64)); this.onDecision?.(d); return d; };
    if (candidate.expiresSessionTimeMs <= now) return make("expired");
    if (this.currentSession !== undefined && (candidate.sessionId !== this.currentSession || candidate.timelineEpoch !== this.currentEpoch)) return make("wrong-session");
    if (this.semantic.has(candidate.candidateId)) return make("semantic-duplicate");
    const last = this.cooldown.get(candidate.cooldownGroup); if (last !== undefined && now - last < this.cooldownMs && candidate.renderParameters.relation !== "fastest-in-class") return make("cooldown-active");
    this.semantic.add(candidate.candidateId); this.queue.push(candidate); this.queue.sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.sourceSequence - b.sourceSequence);
    if (this.queue.length > this.maxQueue) { const dropped = this.queue.pop()!; if (dropped.candidateId === candidate.candidateId) return make("queue-capacity"); this.onDecision?.({ candidateId: dropped.candidateId, decisionId: `${dropped.candidateId}/${dropped.policyVersion}`, reason: "queue-capacity", decidedSessionTimeMs: now }); }
    return make("selected");
  }
  selectNext(now = this.now()): LiveEngineerRuntimeCandidate | null {
    this.prune(now);
    while (this.queue.length) { const candidate = this.queue.shift()!; if (candidate.expiresSessionTimeMs <= now) { this.decide(candidate, "expired", now); continue; } if (!this.revalidate(candidate)) { this.decide(candidate, "context-blocked", now); continue; } this.cooldown.set(candidate.cooldownGroup, now); this.onSelected?.(candidate); return candidate; }
    return null;
  }
  get pendingCount(): number { return this.queue.length; }
  get diagnostics(): readonly LiveEngineerDecisionV1[] { return this.recent; }
  clear(): void { this.reset(this.currentSession, this.currentEpoch); }
  private decide(candidate: LiveEngineerRuntimeCandidate, reason: LiveEngineerDecisionReasonV1, now: number): void { const d = { candidateId: candidate.candidateId, decisionId: `${candidate.candidateId}/${candidate.policyVersion}`, reason, decidedSessionTimeMs: now }; this.recent.push(d); this.onDecision?.(d); }
  private prune(now: number): void { for (const [key, at] of this.cooldown) if (now - at >= this.cooldownMs) this.cooldown.delete(key); }
}
