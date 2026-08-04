import { parseTestChanges, summarizeTestChange } from "@shared/racing/experiments/test-changes";

/** Parse stored appliedChanges JSON into normalized typed change rows. */
export const parseAppliedChanges = parseTestChanges;

/** One-line summary for collapsed version rows. */
export function summarizeAppliedChanges(json: string | null | undefined): string | null {
  const changes = parseTestChanges(json);
  if (changes.length === 0) return null;
  return changes.map(summarizeTestChange).join(", ");
}
