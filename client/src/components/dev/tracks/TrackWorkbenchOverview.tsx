import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { logicalSegmentCounts } from "../../../../../shared/racing/tracks/segment-label";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../ui/empty";
import { Skeleton } from "../../ui/skeleton";
import { useTrackSectors, useTrackTimingSectorLayout } from "../../../hooks/track-queries";
import type { GameId } from "../../../../../shared/games/ids";
import type { TrackConfiguration } from "../../../../../shared/racing/tracks/configuration";
import type { TrackImageryConfigurationIndex } from "../../../../../shared/racing/tracks/imagery";

interface CatalogTrack {
  ordinal: number;
  name: string;
  variant?: string | null;
}

interface GuideEnvelope {
  guide: { corners?: Array<unknown>; priorityCorners?: string[] } | null;
}

interface SegmentEnvelope {
  source?: string;
  segments?: Array<{ type: string; group?: string }>;
}

interface TrackTimingSummary {
  starts: number[] | null;
  ownership: "game" | "raceiq";
  editable: boolean;
  hasRecording: boolean;
}

function toolPath(tool: "geometry" | "guides" | "imagery", gameId: GameId, trackOrdinal: number) {
  return { to: `/dev/tracks/$gameId/$trackOrdinal/${tool}` as const, params: { gameId, trackOrdinal: String(trackOrdinal) } };
}

function SummaryCard({
  title,
  description,
  children,
  href,
  testId,
}: {
  title: string;
  description: string;
  children: ReactNode;
  href: { to: string; params: Record<string, string>; search?: Record<string, unknown> };
  testId: string;
}) {
  return (
    <Card className="flex min-h-44 flex-col">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 text-sm text-app-text-muted">{children}</CardContent>
      <CardFooter>
        <Link data-testid={testId} to={href.to} params={href.params} search={href.search} className="text-sm text-app-accent hover:underline">
          Open {title.toLowerCase()}
        </Link>
      </CardFooter>
    </Card>
  );
}

export function TrackWorkbenchOverview({ gameId, trackOrdinal }: { gameId: GameId; trackOrdinal: number }) {
  const catalogQuery = useQuery({
    queryKey: ["tracks", gameId],
    queryFn: async () => {
      const response = await fetch(`/api/tracks?gameId=${encodeURIComponent(gameId)}`);
      if (!response.ok) throw new Error("Unable to load track catalog");
      return (await response.json()) as CatalogTrack[];
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
  const configurationQuery = useQuery({
    queryKey: ["track-configurations"],
    queryFn: async () => {
      const response = await fetch("/api/dev/track-configurations");
      if (!response.ok) throw new Error("Unable to load track configurations");
      return (await response.json()) as TrackConfiguration[];
    },
  });
  const imageryQuery = useQuery({
    queryKey: ["track-imagery-configurations"],
    queryFn: async () => {
      const response = await fetch("/api/dev/track-imagery");
      if (!response.ok) throw new Error("Unable to load imagery configurations");
      return (await response.json()) as TrackImageryConfigurationIndex;
    },
  });
  const guideQuery = useQuery({
    queryKey: ["dev-track-guide", trackOrdinal, gameId],
    queryFn: async () => {
      const response = await fetch(`/api/dev/track-guides/${trackOrdinal}?gameId=${encodeURIComponent(gameId)}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Unable to load track guide");
      return (await response.json()) as GuideEnvelope;
    },
  });
  const sectorsQuery = useTrackSectors(trackOrdinal, gameId);
  const timingQuery = useTrackTimingSectorLayout({ gameId, trackOrdinal });
  const timingLayout = (timingQuery.data ?? { starts: null, ownership: "raceiq", editable: true, hasRecording: false }) as TrackTimingSummary;
  const catalogTrack = catalogQuery.data?.find((track) => track.ordinal === trackOrdinal);
  const configuration = configurationQuery.data?.find((entry) => entry.gameId === gameId && entry.trackOrdinal === trackOrdinal) ?? null;
  const imageryConfigured = imageryQuery.data?.layouts.some((layout) => layout.gameId === gameId && layout.trackOrdinal === trackOrdinal) ?? false;
  const segmentEnvelope = sectorsQuery.data as SegmentEnvelope | null | undefined;
  const segments = segmentEnvelope?.segments ?? [];
  const { corners: turns, straights } = logicalSegmentCounts(segments);
  const starts = timingLayout.starts ?? [];
  const loading = catalogQuery.isLoading || configurationQuery.isLoading || imageryQuery.isLoading || guideQuery.isLoading || sectorsQuery.isLoading || timingQuery.isLoading;
  const error = [catalogQuery.error, configurationQuery.error, imageryQuery.error, guideQuery.error, sectorsQuery.error, timingQuery.error].find(Boolean);

  if (loading) {
    return (
      <div className="grid gap-4 p-4 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-44 rounded-xl" />)}
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-4">
        <Alert variant="destructive">
          <AlertTitle>Unable to load track status</AlertTitle>
          <AlertDescription>{error instanceof Error ? error.message : "Unknown track data error"}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!catalogTrack) {
    return (
      <div className="p-4">
        <Empty>
          <EmptyHeader><EmptyTitle>Track not found</EmptyTitle><EmptyDescription>Selected catalog row is unavailable for this game.</EmptyDescription></EmptyHeader>
          <Link to="/dev/tracks" className="text-sm text-app-accent hover:underline">Change track</Link>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h2 className="text-xl font-semibold text-app-text">{catalogTrack.name}</h2>
          <p className="text-sm text-app-text-muted">{catalogTrack.variant || "Main"} · {gameId} · ordinal {trackOrdinal}</p>
        </div>
        <Badge variant={configuration?.confirmation ? "success" : configuration ? "warning" : "neutral"}>
          {configuration?.confirmation ? "Confirmed" : configuration ? "Needs confirmation" : "Unassigned"}
        </Badge>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <SummaryCard testId="dev-track-tool-turns" title="Turns" description="Resolved corner and straight segments." href={{ ...toolPath("geometry", gameId, trackOrdinal), search: { mode: "turns" } }}>
          {segments.length > 0 ? <>{segmentEnvelope?.source || "Resolved"} · {turns} turns · {straights} straights</> : "Missing segment data"}
        </SummaryCard>
        <SummaryCard testId="dev-track-tool-sectors" title="Sectors" description="Effective timing-sector starts and ownership." href={{ ...toolPath("geometry", gameId, trackOrdinal), search: { mode: "sectors" } }}>
          {starts.length > 0 ? <>{starts.length} starts · <Badge variant="neutral">{timingLayout.ownership === "game" ? "Game supplied · read-only" : "RaceIQ · editable"}</Badge></> : timingLayout.ownership === "game" ? <span>Game supplied · no recorded layout</span> : <span>Missing timing-sector layout</span>}
        </SummaryCard>
        <SummaryCard testId="dev-track-tool-guides" title="Guides" description="Canonical guide authoring and resolved preview." href={toolPath("guides", gameId, trackOrdinal)}>
          {guideQuery.data?.guide ? `${guideQuery.data.guide.corners?.length ?? 0} corners · ${guideQuery.data.guide.priorityCorners?.length ?? 0} priorities` : "Missing guide · create document"}
        </SummaryCard>
        <SummaryCard testId="dev-track-tool-imagery" title="Imagery" description="Venue base, calibration, and layer configuration." href={toolPath("imagery", gameId, trackOrdinal)}>
          {imageryConfigured ? "Configured" : "Missing · create or import imagery"}
        </SummaryCard>
      </div>
    </div>
  );
}
