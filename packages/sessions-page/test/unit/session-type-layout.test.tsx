import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { KNOWN_GAME_IDS, type GameId } from "@raceiq/shared/games/ids";
import type { LapMeta, SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { host, m } from "../fixtures/host";

mock.module("@tanstack/react-router", () => ({ useNavigate: () => () => undefined }));
mock.module("@/components/ui/badge", () => ({
  Badge: ({ children, title }: { children: string; title?: string }) => <span data-session-type="" title={title}>{children}</span>,
}));

const { SessionTypeBadge } = await import("../../../../client/src/components/SessionTypeBadge");
const { SessionDesktopTable } = await import("../../ui/SessionDesktopTable");
const { SessionMobileList } = await import("../../ui/SessionMobileList");
const { SessionsPageProvider } = await import("../../ui/host");

const renderingHost = {
  ...host,
  Table: ({ children }) => <table>{children}</table>,
  TableHeader: ({ children }) => <thead>{children}</thead>,
  TableBody: ({ children }) => <tbody>{children}</tbody>,
  TableRow: ({ children }) => <tr>{children}</tr>,
  TableCell: ({ children }) => <td>{children}</td>,
  TableHead: ({ children }) => <th>{children}</th>,
  SortableTableHead: ({ children }) => <th>{children}</th>,
  SessionTypeBadge,
  useLiveCaptureLifecycle: () => null,
  getLocale: () => "en",
  formatLapTime: String,
  bestSectorLapIds: () => [],
} satisfies typeof host;

const processing = { state: "ready", stage: null, error: null } as const;
const createdAt = "2026-11-11T12:00:00Z";
const lap: LapMeta = {
  id: 10, sessionId: 1, lapNumber: 1, lapTime: 90, isValid: true,
  classification: "in_lap", createdAt, carId: "car", trackId: "track", processing,
};
const noop = () => undefined;

function render(gameId: GameId, sessionType?: string) {
  const session: SessionMeta = { id: 1, createdAt, carId: "car", trackId: "track", processing, sessionType };
  const shared = {
    gameId, lapsBySession: new Map([[session.id, [lap]]]), trackNames: {}, carNames: {},
    isLoading: false, sessionsError: false, emptyMessage: "Empty",
    expandedSessions: new Set([session.id]), selectedSessions: new Set<number>(), selectedLaps: new Set<number>(),
    sectorCount: 3, lapSortKey: "lap", lapSortDir: "asc",
    toggleExpand: noop, refreshProcessingStatus: noop, toggleSessionSelection: noop,
    toggleLapSelection: noop, toggleLapSort: noop, saveSessionNotes: noop, analyseSession: noop,
  } as const;
  const queryClient = new QueryClient();
  const markup = (view: React.ReactNode) => renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SessionsPageProvider host={renderingHost}>{view}</SessionsPageProvider>
    </QueryClientProvider>,
  );

  return {
    desktop: markup(<SessionDesktopTable {...shared} pageItems={[session]} sortKey="date" sortDir="asc"
      toggleSort={noop} setSelectedSessions={noop} setSelectedLaps={noop} />),
    mobile: markup(<SessionMobileList {...shared} sessions={[session]} />),
  };
}

describe.each(KNOWN_GAME_IDS)("Sessions presentation for %s", (gameId) => {
  test.each([
    ["known", "qualifying", true],
    ["missing", undefined, false],
    ["unknown", "unknown", false],
  ] as const)("renders %s session types on desktop and mobile", (_scenario, type, hasBadge) => {
    const { desktop, mobile } = render(gameId, type);
    const typeHeader = `<th>${m.label_type()}</th>`;
    const typeBadge = '<span data-session-type="" title="Qualifying">Q</span>';
    expect(desktop.split(typeHeader)).toHaveLength(2);
    expect(mobile).not.toContain(typeHeader);

    for (const markup of [desktop, mobile]) {
      expect(markup.includes(typeBadge)).toBe(hasBadge);
      expect(markup.split('data-session-type=""')).toHaveLength(hasBadge ? 2 : 1);
      expect(markup).toContain(`<th>${m.sessions_col_classification()}</th>`);
      expect(markup).toContain(m.sessions_lap_classification_in_lap());
      const expandedTable = markup.slice(markup.lastIndexOf("<table>"));
      expect([...expandedTable.matchAll(/<th>(.*?)<\/th>/g)].map((match) => match[1])).toEqual([
        "", m.label_lap(), "", m.label_time(), m.sessions_col_classification(), "S1", "S2", "S3", m.sessions_col_notes(),
      ]);
    }
  });
});
