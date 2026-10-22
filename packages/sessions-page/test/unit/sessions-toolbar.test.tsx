import { describe, expect, mock, test } from "bun:test";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LapMeta, SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { host, m } from "../fixtures/host";
import type { SessionsPageHost } from "../../contracts";

mock.module("@tanstack/react-router", () => ({
  useNavigate: () => () => undefined,
  useSearch: () => ({}),
}));

type CapturedButtonProps = ComponentProps<SessionsPageHost["Button"]>;
const capturedButtons: CapturedButtonProps[] = [];
const Button: SessionsPageHost["Button"] = (props) => {
  capturedButtons.push(props);
  return <button disabled={props.disabled}>{props.children}</button>;
};

// Load after mocking the router so the unit test needs no application router.
const { SessionToolbar, SessionsPageProvider } = await import("@raceiq/sessions-page/ui");

const session: SessionMeta = { id: 1, trackId: "10", carId: "20", createdAt: "" };
const sessions = [session];
const lap: LapMeta = { id: 101, sessionId: 1, lapNumber: 1, lapTime: 90, isValid: true, classification: null, createdAt: "", carId: "", trackId: "" };
const secondLap: LapMeta = { id: 102, sessionId: 1, lapNumber: 2, lapTime: 90, isValid: true, classification: null, createdAt: "", carId: "", trackId: "" };

type ToolbarOverrides = Partial<Pick<ComponentProps<typeof SessionToolbar>, "exporting" | "runExport">>;

function toolbar(selectedLaps: Set<number>, allLaps: LapMeta[] = [lap], toolbarSessions: SessionMeta[] = sessions, overrides: ToolbarOverrides = {}) {
  capturedButtons.length = 0;
  return renderToStaticMarkup(
    createElement(SessionsPageProvider, { host: { ...host, Button }, children: createElement(SessionToolbar, {
      sessions: toolbarSessions,
      allLaps,
      filteredCount: 1,
      isLoading: false,
      sessionsError: false,
      tab: "mine",
      setTab: () => undefined,
      favoriteOnly: false,
      setFavoriteOnly: () => undefined,
      search: "",
      setSearch: () => undefined,
      setPage: () => undefined,
      selectedSessions: new Set(),
      selectedLaps,
      clearSelection: () => undefined,
      exporting: overrides.exporting ?? false,
      runExport: overrides.runExport ?? (() => undefined),
      setImportOpen: () => undefined,
      openCleanup: () => undefined,
      confirmDelete: false,
      setConfirmDelete: () => undefined,
      deleteSelected: () => undefined,
      isDeleting: false,
      deleteError: null,
    }) }),
  );
}

function capturedExportButton(): CapturedButtonProps | undefined {
  return capturedButtons.find(({ children }) => children === m.label_export() || children === m.common_loading());
}

describe("Sessions toolbar controls", () => {

  test("exports every selected lap id", () => {
    let selection: { lapIds?: number[]; sessionIds?: number[] } | undefined;
    toolbar(new Set([secondLap.id, lap.id]), [lap, secondLap], sessions, {
      runExport: (value) => {
        selection = value;
      },
    });

    capturedExportButton()?.onClick?.({} as never);

    expect(selection?.lapIds?.toSorted((a, b) => a - b)).toEqual([lap.id, secondLap.id]);
  });

  test("disables Export and shows loading while exporting", () => {
    const markup = toolbar(new Set([lap.id]), [lap], sessions, { exporting: true });

    expect(capturedExportButton()?.disabled).toBe(true);
    expect(markup).toContain(m.common_loading());
  });

  test("keeps legacy exports enabled when readiness metadata is absent", () => {
    toolbar(new Set([lap.id]), [{ ...lap, source: null, standaloneCaptureReady: undefined }]);

    expect(capturedExportButton()?.disabled).toBeFalsy();
  });

  test("explains and disables export when capture is explicitly unavailable", () => {
    const markup = toolbar(new Set([lap.id]), [{ ...lap, source: null, standaloneCaptureReady: false }]);

    expect(capturedExportButton()?.disabled).toBe(true);
    expect(markup).toContain(m.sessions_export_capture_not_ready());
  });


  test.each([{ ids: [] }, { ids: [lap.id] }, { ids: [lap.id, secondLap.id, 103] }])("keeps Compare visible but disabled for selection %j", ({ ids }) => {
    toolbar(new Set(ids), [lap, secondLap]);
    expect(capturedButtons.find(({ children }) => children === m.sessions_compare_two())?.disabled).toBe(true);
  });

  test("enables Compare for exactly two compatible laps", () => {
    toolbar(new Set([lap.id, secondLap.id]), [lap, secondLap]);
    expect(capturedButtons.find(({ children }) => children === m.sessions_compare_two())?.disabled).toBe(false);
  });
});
