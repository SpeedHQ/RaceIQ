import type { LapMeta, RacingIdentityFields, SessionMeta } from "@raceiq/shared/racing/sessions/types";
import type { LapSortKey, SessionsTab, SortDir, SortKey } from "./types";
import type { SessionNames } from "../contracts";
import { parseUtcTimestamp } from "@raceiq/frontend-pure/utc-date";

export const PAGE_SIZE = 25;

export function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function fuzzyToken(token: string, field: string): boolean {
  return normalize(field).includes(normalize(token));
}


export function sessionTrackName(session: RacingIdentityFields & { gameId?: string }, names: SessionNames): string {
  if (session.trackId != null) return names.trackNames[session.trackId] ?? session.trackId;
  return "";
}

export function sessionCarName(session: RacingIdentityFields & { gameId?: string }, names: SessionNames): string {
  if (session.carId != null) return names.carNames[session.carId] ?? session.carId;
  return "";
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
      case "date": valueA = parseUtcTimestamp(a.createdAt).getTime(); valueB = parseUtcTimestamp(b.createdAt).getTime(); break;
      case "track": valueA = sessionTrackName(a, names); valueB = sessionTrackName(b, names); break;
      case "car": valueA = sessionCarName(a, names); valueB = sessionCarName(b, names); break;
      case "laps": valueA = a.lapCount ?? 0; valueB = b.lapCount ?? 0; break;
      case "best": valueA = a.bestLapTime ?? Infinity; valueB = b.bestLapTime ?? Infinity; break;
      case "type": valueA = a.sessionType ?? ""; valueB = b.sessionType ?? ""; break;
      case "result": {
        const positionA = a.finishingPosition;
        const positionB = b.finishingPosition;
        if (positionA == null) return positionB == null ? 0 : 1;
        if (positionB == null) return -1;
        valueA = positionA;
        valueB = positionB;
        break;
      }
      default: return 0;
    }
    if (typeof valueA === "string") {
      const comparison = valueA.localeCompare(valueB as string);
      return sortDir === "asc" ? comparison : -comparison;
    }
    return sortDir === "asc" ? valueA - (valueB as number) : (valueB as number) - valueA;
  });
}

export function filterSessions(sessions: SessionMeta[], search: string, tab: SessionsTab, names: SessionNames, favoriteOnly = false): SessionMeta[] {
  const query = search.toLowerCase().trim();
  const tokens = query.split(/\s+/).filter(Boolean);
  return sessions.filter((session) => {
    if ((session.ownership ?? "mine") !== tab) return false;
    if (favoriteOnly && !session.isFavorite) return false;
    if (!tokens.length) return true;
    const track = sessionTrackName(session, names).toLowerCase();
    const car = sessionCarName(session, names).toLowerCase();
    const notes = (session.notes ?? "").toLowerCase();
    return tokens.every((token) => fuzzyToken(token, track) || fuzzyToken(token, car) || fuzzyToken(token, notes));
  });
}

export function paginateSessions(sessions: SessionMeta[], page: number, pageSize = PAGE_SIZE): { items: SessionMeta[]; totalPages: number } {
  return { items: sessions.slice(page * pageSize, (page + 1) * pageSize), totalPages: Math.max(1, Math.ceil(sessions.length / pageSize)) };
}

export function sortLaps(laps: LapMeta[], sortKey: LapSortKey, sortDir: SortDir): LapMeta[] {
  return [...laps].sort((a, b) => {
    let comparison: number;
    if (typeof sortKey === "number") {
      const aTime = a.sectorTimes?.[sortKey] ?? 0;
      const bTime = b.sectorTimes?.[sortKey] ?? 0;
      if (aTime <= 0 || bTime <= 0) return (aTime <= 0 ? 1 : 0) - (bTime <= 0 ? 1 : 0);
      comparison = aTime - bTime;
    } else if (sortKey === "notes") {
      comparison = (a.notes ?? "").localeCompare(b.notes ?? "");
    } else {
      comparison = sortKey === "lap" ? a.lapNumber - b.lapNumber : a.lapTime - b.lapTime;
    }
    return sortDir === "asc" ? comparison : -comparison;
  });
}
export function selectionIncludesMotec(selection: { lapIds?: readonly number[]; sessionIds?: readonly number[] }, sessions: readonly SessionMeta[], laps: readonly LapMeta[]): boolean {
  const sessionIds = new Set(selection.sessionIds ?? []);
  const lapIds = new Set(selection.lapIds ?? []);
  for (const lap of laps) if (lapIds.has(lap.id)) sessionIds.add(lap.sessionId);
  return sessions.some((session) => sessionIds.has(session.id) && session.source === "motec");
}
