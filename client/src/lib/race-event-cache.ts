import type { RaceEvent, RaceEventPage } from "@shared/racing/events/contracts";
import type { InfiniteData } from "@tanstack/react-query";

export type RaceEventInfiniteData = InfiniteData<RaceEventPage, string | undefined>;

export function compareRaceEventOrder(left: RaceEvent, right: RaceEvent): number {
  return left.timelineEpoch - right.timelineEpoch || left.sequence - right.sequence || left.eventOrder - right.eventOrder || left.eventId.localeCompare(right.eventId);
}

export function canonicalRaceEvents(events: readonly RaceEvent[]): RaceEvent[] {
  const byId = new Map<string, RaceEvent>();
  for (const event of events) byId.set(event.eventId, event);
  return [...byId.values()].sort(compareRaceEventOrder);
}

function upsertExistingRaceEvents(data: RaceEventInfiniteData, candidates: readonly RaceEvent[]): { data: RaceEventInfiniteData; additions: RaceEvent[] } {
  const candidateById = new Map(candidates.map((event) => [event.eventId, event] as const));
  const matchedIds = new Set<string>();
  let changed = false;
  const pages = data.pages.map((page) => {
    let pageChanged = false;
    const items = page.items.map((event) => {
      const candidate = candidateById.get(event.eventId);
      if (!candidate) return event;
      matchedIds.add(event.eventId);
      pageChanged = true;
      return candidate;
    });
    if (!pageChanged) return page;
    changed = true;
    return { ...page, items };
  });
  const additions = canonicalRaceEvents([...candidateById.values()].filter((event) => !matchedIds.has(event.eventId)));
  return {
    data: changed ? { ...data, pages } : data,
    additions,
  };
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

  const merged = upsertExistingRaceEvents(data, appended);
  if (merged.additions.length === 0) return merged.data;
  const lastPage = merged.data.pages[merged.data.pages.length - 1]!;
  return {
    ...merged.data,
    pages: [...merged.data.pages, { items: merged.additions, nextCursor: lastPage.nextCursor, tailCursor: lastPage.tailCursor }],
    pageParams: [...merged.data.pageParams, lastPage.nextCursor ?? undefined],
  };
}

export function mergeRecoveredRaceEventPage(data: RaceEventInfiniteData, recovered: RaceEventPage): RaceEventInfiniteData {
  if (data.pages.length === 0) return data;

  const merged = upsertExistingRaceEvents(data, recovered.items);
  const lastPage = merged.data.pages[merged.data.pages.length - 1]!;
  if (merged.additions.length === 0) {
    if (lastPage.nextCursor === recovered.nextCursor && lastPage.tailCursor === recovered.tailCursor) return merged.data;
    return replaceTailPage(merged.data, {
      ...lastPage,
      nextCursor: recovered.nextCursor,
      tailCursor: recovered.tailCursor ?? lastPage.tailCursor,
    });
  }
  return {
    ...merged.data,
    pages: [...merged.data.pages, { ...recovered, items: merged.additions }],
    pageParams: [...merged.data.pageParams, lastPage.nextCursor ?? undefined],
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
