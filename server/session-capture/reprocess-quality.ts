import type { QualityFact, RecordingLifecycleState, RecordingQualitySummary } from "../../shared/racing/quality/contracts";

function isNonReplayableLifecycleFact(fact: QualityFact): boolean {
  if (fact.code === "writer_drop" || fact.code === "source_reconnect") return true;
  return fact.code === "timeline_discontinuity" && typeof fact.details?.lifecycleEvent === "string";
}

function lifecycleFactKey(fact: QualityFact): string {
  if (fact.eventIds.length > 0) return `${fact.code}:${[...fact.eventIds].sort().join(",")}`;
  return `${fact.code}:${fact.id}`;
}

function mergedLifecycleState(current: RecordingLifecycleState, facts: readonly QualityFact[]): RecordingLifecycleState {
  if (current !== "exact" && current !== "minor_gaps") return current;
  return facts.some(({ code }) => code === "writer_drop" || code === "timeline_discontinuity" || code === "source_reconnect") ? "degraded" : current;
}

/**
 * Raw replay can reconstruct packet-derived facts, but not live source lifecycle
 * or writer failures. Preserve only that non-replayable evidence from prior quality.
 */
export function mergeReprocessedRecordingQuality(previous: RecordingQualitySummary | null | undefined, recomputed: RecordingQualitySummary): RecordingQualitySummary {
  if (!previous) return recomputed;

  const facts: QualityFact[] = [];
  const factIds = new Set<string>();
  const lifecycleKeys = new Set<string>();

  for (const priorFact of previous.facts) {
    if (!isNonReplayableLifecycleFact(priorFact)) continue;
    const key = lifecycleFactKey(priorFact);
    if (lifecycleKeys.has(key)) continue;
    lifecycleKeys.add(key);
    factIds.add(priorFact.id);
    facts.push(priorFact);
  }

  for (const currentFact of recomputed.facts) {
    if (isNonReplayableLifecycleFact(currentFact)) {
      const key = lifecycleFactKey(currentFact);
      if (lifecycleKeys.has(key)) continue;
      lifecycleKeys.add(key);
    }

    let id = currentFact.id;
    if (factIds.has(id)) {
      const base = `${id}:reprocessed`;
      id = base;
      let suffix = 2;
      while (factIds.has(id)) id = `${base}:${suffix++}`;
    }
    factIds.add(id);
    facts.push(id === currentFact.id ? currentFact : { ...currentFact, id });
  }

  return {
    ...recomputed,
    lifecycleState: mergedLifecycleState(recomputed.lifecycleState, facts),
    facts,
  };
}
