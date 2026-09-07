import type { LapMeta, SessionMeta } from "@shared/racing/sessions/types";
import type { LapSortKey, SessionNames, SessionsTab, SortDir, SortKey } from "./types";

export const PAGE_SIZE = 25;

export function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function fuzzyToken(token: string, field: string): boolean {
  return normalize(field).includes(normalize(token));
}

export function formatSessionType(type?: string): string {
  if (!type || type === "unknown") return "";
  return type.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function groupLapsBySession(laps: LapMeta[]): Map<number, LapMeta[]> {
  const grouped = new Map<number, LapMeta[]>();
  for (const lap of laps) {
    const sessionLaps = grouped.get(lap.sessionId) ?? [];
    sessionLaps.push(lap);
    grouped.set(lap.sessionId, sessionLaps);
  }
  return grouped;
}

export function sortSessions(sessions: SessionMeta[], sortKey: SortKey, sortDir: SortDir, names: SessionNames): SessionMeta[] {
  return [...sessions].sort((a, b) => {
    let valueA: string | number;
    let valueB: string | number;
    switch (sortKey) {
      case "date":
        valueA = new Date(a.createdAt).getTime();
        valueB = new Date(b.createdAt).getTime();
        break;
      case "track":
        valueA = names.trackNames[a.trackOrdinal] ?? `Track ${a.trackOrdinal}`;
        valueB = names.trackNames[b.trackOrdinal] ?? `Track ${b.trackOrdinal}`;
        break;
      case "car":
        valueA = names.carNames[a.carOrdinal] ?? `Car ${a.carOrdinal}`;
        valueB = names.carNames[b.carOrdinal] ?? `Car ${b.carOrdinal}`;
        break;
      case "laps":
        valueA = a.lapCount ?? 0;
        valueB = b.lapCount ?? 0;
        break;
      case "best":
        valueA = a.bestLapTime ?? Infinity;
        valueB = b.bestLapTime ?? Infinity;
        break;
      case "type":
        valueA = a.sessionType ?? "";
        valueB = b.sessionType ?? "";
        break;
      case "result": {
        const positionA = a.finishingPosition;
        const positionB = b.finishingPosition;
        if (positionA == null) return positionB == null ? 0 : 1;
        if (positionB == null) return -1;
        valueA = positionA;
        valueB = positionB;
        break;
      }
      default:
        return 0;
    }
    if (typeof valueA === "string") {
      const comparison = valueA.localeCompare(valueB as string);
      return sortDir === "asc" ? comparison : -comparison;
    }
    return sortDir === "asc" ? valueA - (valueB as number) : (valueB as number) - valueA;
  });
}

export function filterSessions(sessions: SessionMeta[], search: string, tab: SessionsTab, names: SessionNames): SessionMeta[] {
  const query = search.toLowerCase().trim();
  const tokens = query.split(/\s+/).filter(Boolean);
  return sessions.filter((session) => {
    if ((session.ownership ?? "mine") !== tab) return false;
    if (!tokens.length) return true;
    const track = (names.trackNames[session.trackOrdinal] ?? "").toLowerCase();
    const car = (names.carNames[session.carOrdinal] ?? "").toLowerCase();
    const notes = (session.notes ?? "").toLowerCase();
    return tokens.every((token) => fuzzyToken(token, track) || fuzzyToken(token, car) || fuzzyToken(token, notes));
  });
}

export function paginateSessions(sessions: SessionMeta[], page: number, pageSize = PAGE_SIZE): { items: SessionMeta[]; totalPages: number } {
  return {
    items: sessions.slice(page * pageSize, (page + 1) * pageSize),
    totalPages: Math.max(1, Math.ceil(sessions.length / pageSize)),
  };
}

export function sortLaps(laps: LapMeta[], sortKey: LapSortKey, sortDir: SortDir): LapMeta[] {
  return [...laps].sort((a, b) => {
    const comparison = sortKey === "lap" ? a.lapNumber - b.lapNumber : a.lapTime - b.lapTime;
    return sortDir === "asc" ? comparison : -comparison;
  });
}
export function selectionIncludesMotec(
  selection: { lapIds?: readonly number[]; sessionIds?: readonly number[] },
  sessions: readonly SessionMeta[],
  laps: readonly LapMeta[],
): boolean {
  const sessionIds = new Set(selection.sessionIds ?? []);
  const lapIds = new Set(selection.lapIds ?? []);
  for (const lap of laps) {
    if (lapIds.has(lap.id)) sessionIds.add(lap.sessionId);
  }
  return sessions.some((session) => sessionIds.has(session.id) && session.source === "motec");
}
