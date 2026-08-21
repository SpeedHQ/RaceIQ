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

export function mergeAppendedRaceEvents(data: RaceEventInfiniteData, appended: readonly RaceEvent[]): RaceEventInfiniteData {
  if (data.pages.length === 0 || appended.length === 0) return data;

  const knownIds = new Set(data.pages.flatMap((page) => page.items.map((event) => event.eventId)));
  const additions = appended.filter((event) => !knownIds.has(event.eventId));
  if (additions.length === 0) return data;

  const lastPageIndex = data.pages.length - 1;
  return {
    ...data,
    pages: data.pages.map((page, index) =>
      index === lastPageIndex ? { ...page, items: canonicalRaceEvents([...page.items, ...additions]) } : page,
    ),
  };
}

export function mergeRecoveredRaceEventPage(data: RaceEventInfiniteData, recovered: RaceEventPage): RaceEventInfiniteData {
  if (data.pages.length === 0) return data;

  const lastPageIndex = data.pages.length - 1;
  const lastPage = data.pages[lastPageIndex]!;
  return {
    ...data,
    pages: data.pages.map((page, index) =>
      index === lastPageIndex
        ? {
            ...page,
            items: canonicalRaceEvents([...lastPage.items, ...recovered.items]),
            nextCursor: recovered.nextCursor,
            tailCursor: recovered.tailCursor ?? lastPage.tailCursor,
          }
        : page,
    ),
  };
}

export async function recoverRaceEventTail(
  data: RaceEventInfiniteData,
  fetchPage: (cursor: string) => Promise<RaceEventPage>,
): Promise<RaceEventInfiniteData> {
  let recovered = data;
  let cursor = recovered.pages.at(-1)?.tailCursor ?? null;
  const seenCursors = new Set<string>();

  while (cursor != null) {
    if (seenCursors.has(cursor)) {
      throw new Error("Race-event tail catch-up cursor did not advance");
    }
    seenCursors.add(cursor);

    const page = await fetchPage(cursor);
    recovered = mergeRecoveredRaceEventPage(recovered, page);
    if (page.nextCursor == null) break;
    if (page.tailCursor == null) {
      throw new Error("Race-event tail catch-up cursor is missing");
    }
    cursor = page.tailCursor;
  }

  return recovered;
}
