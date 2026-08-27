import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LapMeta, SessionMeta } from "@shared/racing/sessions/types";
import { m } from "../../src/paraglide/messages";

mock.module("@tanstack/react-router", () => ({
  useNavigate: () => () => undefined,
}));

// Import after mocking router hook so the toolbar can render without RouterProvider.
const { SessionToolbar } = await import("../../src/components/sessions/SessionToolbar");

const session = { id: 1, trackOrdinal: 10, carOrdinal: 20 } as SessionMeta;
const sessions = [session];
const lap = { id: 101, sessionId: 1 } as LapMeta;
const secondLap = { id: 102, sessionId: 1 } as LapMeta;

function toolbar(selectedLaps: Set<number>, allLaps: LapMeta[] = [lap], toolbarSessions: SessionMeta[] = sessions) {
  return renderToStaticMarkup(
    createElement(SessionToolbar, {
      sessions: toolbarSessions,
      allLaps,
      filteredCount: 1,
      isLoading: false,
      sessionsError: false,
      tab: "mine",
      setTab: () => undefined,
      search: "",
      setSearch: () => undefined,
      setPage: () => undefined,
      selectedSessions: new Set(),
      selectedLaps,
      exporting: false,
      runExport: () => undefined,
      setImportOpen: () => undefined,
      confirmDelete: false,
      setConfirmDelete: () => undefined,
      deleteSelected: () => undefined,
      isDeleting: false,
      deleteError: null,
    }),
  );
}

describe("Sessions toolbar controls", () => {
  test("shows Import button", () => {
    expect(toolbar(new Set())).toContain(m.sessions_import());
  });

  test("shows Export lap when a lap is selected", () => {
    expect(toolbar(new Set([lap.id]))).toContain(m.sessions_export_lap());
  });

  test("shows Compare button for two laps on same track", () => {
    expect(toolbar(new Set([lap.id, secondLap.id]), [lap, secondLap])).toContain(m.sessions_compare_two());
  });
});
