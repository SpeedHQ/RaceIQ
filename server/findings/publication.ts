import type { FindingGenerationReceipt, FindingScope } from "../../shared/racing/findings/types";

export const FINDING_GENERATION_PUBLISHED = "finding-generation-published" as const;

export interface FindingGenerationPublishedEvent {
  readonly type: typeof FINDING_GENERATION_PUBLISHED;
  readonly scope: Readonly<FindingScope>;
  readonly receipt: Readonly<FindingGenerationReceipt>;
  readonly findingIds: readonly string[];
}

export type FindingGenerationSubscriber = (event: FindingGenerationPublishedEvent) => void;

const subscribers = new Set<FindingGenerationSubscriber>();

/** Subscribe to activated finding generations. Returned disposer is idempotent. */
export function subscribeFindingGeneration(subscriber: FindingGenerationSubscriber): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

/** Publish only an already-activated generation. */
export function publishFindingGeneration(
  scope: FindingScope,
  receipt: FindingGenerationReceipt,
  findingIds: readonly string[],
): void {
  if (receipt.status !== "current") {
    throw new Error("Cannot publish a finding generation before activation");
  }
  const event: FindingGenerationPublishedEvent = Object.freeze({
    type: FINDING_GENERATION_PUBLISHED,
    scope: Object.freeze({ ...scope }),
    receipt: Object.freeze({ ...receipt }),
    findingIds: Object.freeze([...new Set(findingIds)].sort((left, right) => left.localeCompare(right))),
  });
  for (const subscriber of [...subscribers]) {
    try {
      subscriber(event);
    } catch (error) {
      console.error("[Findings] Publication subscriber failed:", error);
    }
  }
}
