import type { LapMeta, SessionMeta } from "@shared/racing/sessions/types";

export type SessionsTab = "recorded" | "imported";
export type LapSortKey = "lap" | "time";
export type SortKey = "date" | "track" | "car" | "laps" | "best" | "type";
export type SortDir = "asc" | "desc";

export type SessionNames = {
  trackNames: Record<number, string>;
  carNames: Record<number, string>;
};

export type SessionLapTableProps = {
  session: SessionMeta;
  laps: LapMeta[];
  sectorCount: number;
  lapSortKey: LapSortKey;
  lapSortDir: SortDir;
  toggleLapSort: (key: LapSortKey) => void;
  selectedLaps: Set<number>;
  toggleLapSelection: (id: number) => void;
};

export type SessionSelectionEvent = {
  stopPropagation: () => void;
};

export type SessionSelectionHandlers = {
  selectedSessions: Set<number>;
  toggleSessionSelection: (sessionId: number, event: SessionSelectionEvent) => void;
  selectedLaps: Set<number>;
  toggleLapSelection: (lapId: number) => void;
};
