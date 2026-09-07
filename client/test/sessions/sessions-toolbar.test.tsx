import { describe, expect, mock, test } from "bun:test";
import { createElement, type ButtonHTMLAttributes, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LapMeta, SessionMeta } from "@shared/racing/sessions/types";
import { m } from "../../src/paraglide/messages";

mock.module("@tanstack/react-router", () => ({
  useNavigate: () => () => undefined,
}));

type CapturedButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;
const capturedButtons: CapturedButtonProps[] = [];

mock.module("@/components/ui/button", () => ({
  Button: ({ variant: _variant, size: _size, ...props }: CapturedButtonProps & { variant?: string; size?: string }) => {
    capturedButtons.push(props);
    return createElement("button", props);
  },
}));

// Import after mocking router hook so the toolbar can render without RouterProvider.
const { SessionToolbar } = await import("../../src/components/sessions/SessionToolbar");

const session = { id: 1, trackOrdinal: 10, carOrdinal: 20 } as SessionMeta;
const sessions = [session];
const lap = { id: 101, sessionId: 1 } as LapMeta;
const secondLap = { id: 102, sessionId: 1 } as LapMeta;

type ToolbarOverrides = Partial<Pick<ComponentProps<typeof SessionToolbar>, "exporting" | "runExport">>;

function toolbar(
  selectedLaps: Set<number>,
  allLaps: LapMeta[] = [lap],
  toolbarSessions: SessionMeta[] = sessions,
  overrides: ToolbarOverrides = {},
) {
  capturedButtons.length = 0;
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
      exporting: overrides.exporting ?? false,
      runExport: overrides.runExport ?? (() => undefined),
      setImportOpen: () => undefined,
      confirmDelete: false,
      setConfirmDelete: () => undefined,
      deleteSelected: () => undefined,
      isDeleting: false,
      deleteError: null,
    }),
  );
}

function capturedExportButton(): CapturedButtonProps | undefined {
  return capturedButtons.find(
    ({ children }) => children === m.sessions_export_lap() || children === m.common_loading(),
  );
}

describe("Sessions toolbar controls", () => {
  test("shows Import button", () => {
    expect(toolbar(new Set())).toContain(m.sessions_import());
  });

  test("shows Export lap when a lap is selected", () => {
    expect(toolbar(new Set([lap.id]))).toContain(m.sessions_export_lap());
  });

  test("exports every selected lap id", () => {
    let selection: { lapIds?: number[]; sessionIds?: number[] } | undefined;
    toolbar(new Set([secondLap.id, lap.id]), [lap, secondLap], sessions, {
      runExport: (value) => {
        selection = value;
      },
    });

    capturedExportButton()?.onClick?.({} as never);

    expect(selection).toEqual({ lapIds: [secondLap.id, lap.id] });
  });

  test("disables Export and shows loading while exporting", () => {
    const markup = toolbar(new Set([lap.id]), [lap], sessions, { exporting: true });

    expect(capturedExportButton()?.disabled).toBe(true);
    expect(markup).toContain(m.common_loading());
  });

  test("shows Compare button for two laps on same track", () => {
    expect(toolbar(new Set([lap.id, secondLap.id]), [lap, secondLap])).toContain(m.sessions_compare_two());
  });
});
