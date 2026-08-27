import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LapMeta, SessionMeta } from "@shared/racing/sessions/types";

mock.module("@tanstack/react-router", () => ({
  useNavigate: () => () => undefined,
}));

// Import after mocking router hook so the toolbar can render without RouterProvider.
const { SessionToolbar } = await import("../src/components/sessions/SessionToolbar");

const session = { id: 1, trackOrdinal: 10, carOrdinal: 20 } as SessionMeta;
const lap = { id: 101, sessionId: 1 } as LapMeta;

function toolbar(selectedLaps: Set<number>) {
  return renderToStaticMarkup(
    createElement(SessionToolbar, {
      sessions: [session],
      allLaps: [lap],
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

describe("Sessions toolbar lap export", () => {
  test("shows Export lap when a lap is selected", () => {
    expect(toolbar(new Set([lap.id]))).toContain("Export lap");
  });
});
