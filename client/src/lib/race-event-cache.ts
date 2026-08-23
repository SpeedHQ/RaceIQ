import type { RaceEvent, RaceEventPage } from "@shared/racing/events/contracts";
import type { InfiniteData } from "@tanstack/react-query";

export type RaceEventInfiniteData = InfiniteData<RaceEventPage, string | undefined>;

export function compareRaceEventOrder(left: RaceEvent, right: RaceEvent): number {
  return (
    left.timelineEpoch - right.timelineEpoch ||
    left.sequence - right.sequence ||
    left.eventOrder - right.eventOrder ||
    left.eventId.localeCompare(right.eventId)
  );
}

export function canonicalRaceEvents(events: readonly RaceEvent[]): RaceEvent[] {
  const byId = new Map<string, RaceEvent>();
  for (const event of events) byId.set(event.eventId, event);
  return [...byId.values()].sort(compareRaceEventOrder);
}

function newRaceEvents(data: RaceEventInfiniteData, candidates: readonly RaceEvent[]): RaceEvent[] {
  if (candidates.length === 0) return [];

  const candidateIds = new Set(candidates.map((event) => event.eventId));
  for (const page of data.pages) {
    for (const event of page.items) candidateIds.delete(event.eventId);
  }
  if (candidateIds.size === 0) return [];

  const additions = candidates.filter((event) => candidateIds.delete(event.eventId));
  return additions.length < 2 ? additions : additions.sort(compareRaceEventOrder);
}

function replaceTailPage(data: RaceEventInfiniteData, page: RaceEventPage): RaceEventInfiniteData {
  const lastPageIndex = data.pages.length - 1;
  return {
    ...data,
    pages: [...data.pages.slice(0, lastPageIndex), page],
  };
}

export function mergeAppendedRaceEvents(data: RaceEventInfiniteData, appended: readonly RaceEvent[]): RaceEventInfiniteData {
  if (data.pages.length === 0 || appended.length === 0) return data;

  const additions = newRaceEvents(data, appended);
  if (additions.length === 0) return data;
  const lastPage = data.pages[data.pages.length - 1]!;
  return {
    ...data,
    pages: [...data.pages, { items: additions, nextCursor: lastPage.nextCursor, tailCursor: lastPage.tailCursor }],
    pageParams: [...data.pageParams, lastPage.nextCursor ?? undefined],
  };
}

export function mergeRecoveredRaceEventPage(data: RaceEventInfiniteData, recovered: RaceEventPage): RaceEventInfiniteData {
  if (data.pages.length === 0) return data;

  const additions = newRaceEvents(data, recovered.items);
  const lastPage = data.pages[data.pages.length - 1]!;
  if (additions.length === 0) {
    if (lastPage.nextCursor === recovered.nextCursor && lastPage.tailCursor === recovered.tailCursor) return data;
    return replaceTailPage(data, {
      ...lastPage,
      nextCursor: recovered.nextCursor,
      tailCursor: recovered.tailCursor ?? lastPage.tailCursor,
    });
  }
  return {
    ...data,
    pages: [...data.pages, { ...recovered, items: additions }],
    pageParams: [...data.pageParams, lastPage.nextCursor ?? undefined],
  };
}

export async function recoverRaceEventTail(
  data: RaceEventInfiniteData,
  fetchPage: (cursor: string, signal?: AbortSignal) => Promise<RaceEventPage>,
  signal?: AbortSignal,
): Promise<RaceEventInfiniteData> {
  let recovered = data;
  let cursor = recovered.pages.at(-1)?.tailCursor ?? null;
  const seenCursors = new Set<string>();

  while (cursor != null) {
    if (signal?.aborted) throw signal.reason ?? new Error("Race-event tail recovery aborted");
    if (seenCursors.has(cursor)) {
      throw new Error("Race-event tail catch-up cursor did not advance");
    }
    seenCursors.add(cursor);

    const page = await fetchPage(cursor, signal);
    if (signal?.aborted) throw signal.reason ?? new Error("Race-event tail recovery aborted");
    recovered = mergeRecoveredRaceEventPage(recovered, page);
    if (page.nextCursor == null) break;
    if (page.tailCursor == null) {
      throw new Error("Race-event tail catch-up cursor is missing");
    }
    cursor = page.tailCursor;
  }

  return recovered;
}
