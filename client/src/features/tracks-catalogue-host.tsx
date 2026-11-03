import type { ReactNode } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { TracksCatalogueProvider } from "@raceiq/tracks-catalogue/ui";
import type { TracksCatalogueHost, TracksCatalogueOperations, CatalogueNavigate, TrackOutline, SectorBounds, SourcedTrackSectors, F125TrackCounts, AccSetupCounts, TrackLap, TrackBoundaries } from "@raceiq/tracks-catalogue/contracts";
import type { ResolvedTrackGuide } from "@raceiq/shared/racing/tracks/guide/types";
import { AppInput } from "@/components/ui/AppInput";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { SearchMultiSelect } from "@/components/ui/SearchMultiSelect";
import { SetupSettingsPanel } from "@/components/setup-tune/SetupSettingsPanel";
import { AccTrackGuide, AccTrackSetups } from "@/components/acc/AccTrackSetups";
import { F125TrackGuide } from "@/components/f1/f125/TrackGuide";
import { F125SetupsWithGuide } from "@/components/f1/f125/TrackSetups";
import { F125Leaderboard } from "@/components/f1/F125Leaderboard";
import { ProcessingStatus } from "@/components/ProcessingStatus";
import { useCatalogTunes, useUserTunes, useLaptimes } from "@/hooks/tunes";
import { useTracks, useResolveNames } from "@/hooks/catalog-queries";
import { useBulkDeleteLaps } from "@/hooks/laps";
import { useUnits } from "@/hooks/useUnits";
import { queryKeys } from "@/hooks/query-keys";
import { useGameId, getGameRoute } from "@/stores/game";
import { countryName } from "@/lib/country-names";
import { trackRoutePath, tracksIndexPath } from "@/lib/track-routes";
import { tuneMatchesTrack, tracksMatch } from "@/lib/track-match";
import { parseUtcTimestamp } from "@raceiq/frontend-pure/utc-date";
import { formatLapTime } from "@/lib/format";
import { storedLapsSectorCount } from "@/lib/lap-sectors";
import { drawTrack } from "@/lib/canvas/draw-track";
import { getSemanticCanvasContext } from "@raceiq/scene-3d/rendering/css-canvas";
import { SECTOR_COLOR_VARS, TRACK_CORNER_COLOR_VARS, TRACK_STRAIGHT_COLOR_VARS, VISUALIZATION_COLOR_VARS } from "@raceiq/scene-3d/colors";
import { isDevelopment } from "@/lib/env";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import { client } from "@/lib/rpc";

const operations: TracksCatalogueOperations = {
  f125Tracks: () => client.api["f1-25"].tracks.$get().then((r) => r.json() as unknown as F125TrackCounts[]),
  accSetupCounts: () => client.api.acc["setup-counts"].$get().then((r) => r.json() as Promise<AccSetupCounts>),
  outline: (id, gameId) => client.api["track-outline"][":trackId"]
    .$get({ param: { trackId: encodeURIComponent(id) }, query: { gameId: gameId ?? undefined } })
    .then((r) => r.json() as unknown as TrackOutline),
  sectors: (id, gameId) => client.api["track-sectors"][":trackId"]
    .$get({ param: { trackId: encodeURIComponent(id) }, query: { gameId } })
    .then((r) => r.json() as unknown as SourcedTrackSectors | null),
  sectorBounds: (id, gameId) => client.api["track-sector-boundaries"][":trackId"]
    .$get({ param: { trackId: encodeURIComponent(id) }, query: { gameId } })
    .then((r) => r.json() as unknown as SectorBounds | null),
  laps: (id, gameId) => {
    const request = { param: { trackId: encodeURIComponent(id) }, query: { gameId: gameId ?? undefined } };
    return client.api.tracks[":trackId"]["all-laps"].$get(request)
      .then((r) => r.json() as unknown as TrackLap[] | null);
  },
  guide: (id, gameId) => {
    const request = { param: { trackId: encodeURIComponent(id) }, query: { gameId: gameId ?? undefined } };
    return client.api["track-guide"][":trackId"].$get(request)
      .then((r) => r.json() as unknown as ResolvedTrackGuide | null);
  },
  saveSegments: (id, gameId, segments) => {
    const request = { param: { trackId: encodeURIComponent(id) }, query: { gameId }, json: { segments } };
    return client.api.tracks[":trackId"].segments.$put(request);
  },
  saveSectorBounds: (id, gameId, bounds) => {
    const request = { param: { trackId: encodeURIComponent(id) }, query: { gameId }, json: { s1End: bounds.s1End, s2End: bounds.s2End } };
    return client.api["track-sector-boundaries"][":trackId"].$put(request);
  },
  boundaries: (id, gameId) => client.api["track-boundaries"][":trackId"]
    .$get({ param: { trackId: encodeURIComponent(id) }, query: { gameId: gameId ?? undefined } })
    .then((r) => r.ok ? (r.json() as unknown as TrackBoundaries) : null),
  calibrationComparison: (id) => client.api["track-calibration"][":trackId"].comparison
    .$get({ param: { trackId: encodeURIComponent(id) } })
    .then((r) => r.ok ? r.json() : null),
};

function useCatalogueNavigate(): CatalogueNavigate {
  const navigate = useNavigate();
  return (options) => navigate(options);
}
function useCatalogueParams() {
  const params = useParams({ strict: false });
  return { trackId: "trackId" in params && typeof params.trackId === "string" ? params.trackId : undefined };
}
function useSetupSearch() {
  const search = useSearch({ strict: false });
  return { setup: "setup" in search && typeof search.setup === "string" ? search.setup : undefined };
}
function useSelectSetup() {
  const navigate = useNavigate();
  return (id: string) => { void navigate({ to: ".", search: (previous) => ({ ...previous, setup: id }), replace: true }); };
}
const host: TracksCatalogueHost = {
  m, AppInput, Button, Card, Tabs, TabsContent, TabsList, TabsTrigger,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, SortableTableHead,
  InfoTooltip, SearchSelect, SearchMultiSelect, SetupSettingsPanel,
  AccTrackGuide, AccTrackSetups, F125TrackGuide, F125SetupsWithGuide, F125Leaderboard,
  useTracks, useResolveNames, useCatalogTunes, useUserTunes, useLaptimes, useBulkDeleteLaps, ProcessingStatus,
  useGameId, useUnits, useNavigate: useCatalogueNavigate, useParams: useCatalogueParams, useSetupSearch, useSelectSetup,
  countryName, trackRoutePath, tracksIndexPath, getGameRoute, tuneMatchesTrack, tracksMatch,
  parseUtcTimestamp, formatLapTime, storedLapsSectorCount, drawTrack, getSemanticCanvasContext,
  SECTOR_COLOR_VARS, TRACK_CORNER_COLOR_VARS, TRACK_STRAIGHT_COLOR_VARS, VISUALIZATION_COLOR_VARS,
  isDevelopment, getLocale, queryKeys, operations,
};
export function TracksCatalogueHostProvider({ children }: { children: ReactNode }) {
  return <TracksCatalogueProvider host={host}>{children}</TracksCatalogueProvider>;
}
