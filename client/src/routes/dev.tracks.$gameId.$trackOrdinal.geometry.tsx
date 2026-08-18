import { createFileRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { parseDevTrackIdentity } from "../lib/dev-track-routes";
import { DevTrackGeometryPage } from "../components/track/detail/DevTrackGeometryPage";
import type { TrackInfo } from "../components/track/types";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Skeleton } from "../components/ui/skeleton";

interface CatalogTrack extends Partial<TrackInfo> {
  ordinal: number;
  name: string;
}


function GeometryRoute() {
  const params = useParams({ from: "/dev/tracks/$gameId/$trackOrdinal" });
  const { gameId, trackOrdinal } = parseDevTrackIdentity(params);
  const { mode } = useSearch({ from: "/dev/tracks/$gameId/$trackOrdinal/geometry" });
  const navigate = useNavigate({ from: "/dev/tracks/$gameId/$trackOrdinal/geometry" });
  const trackQuery = useQuery({
    queryKey: ["tracks", gameId],
    queryFn: async () => {
      const response = await fetch(`/api/tracks?gameId=${encodeURIComponent(gameId)}`);
      if (!response.ok) throw new Error("Unable to load track catalog");
      return (await response.json()) as CatalogTrack[];
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (trackQuery.isLoading) return <Skeleton className="m-4 h-[32rem] rounded-xl" />;
  if (trackQuery.error) {
    return <Alert variant="destructive" className="m-4"><AlertTitle>Unable to load geometry</AlertTitle><AlertDescription>{trackQuery.error.message}</AlertDescription></Alert>;
  }
  const catalog = trackQuery.data?.find((track) => track.ordinal === trackOrdinal);
  if (!catalog) {
    return <Empty className="m-4"><EmptyHeader><EmptyTitle>Track not found</EmptyTitle><EmptyDescription>Selected catalog row is unavailable.</EmptyDescription></EmptyHeader></Empty>;
  }
  const track: TrackInfo = {
    ...catalog,
    ordinal: catalog.ordinal,
    name: catalog.name,
    location: catalog.location ?? "",
    country: catalog.country ?? "",
    variant: catalog.variant ?? "",
    lengthKm: catalog.lengthKm ?? 0,
    hasOutline: catalog.hasOutline ?? false,
    createdAt: catalog.createdAt ?? null,
  };
  return (
    <div className="flex flex-col gap-3 p-4">
      <DevTrackGeometryPage
        gameId={gameId}
        track={track}
        mode={mode}
        onModeChange={(nextMode) => void navigate({ search: { mode: nextMode } })}
      />
    </div>
  );
}

export const Route = createFileRoute("/dev/tracks/$gameId/$trackOrdinal/geometry")({
  validateSearch: (search: Record<string, unknown>) => ({ mode: search.mode === "sectors" ? "sectors" : "turns" } as const),
  beforeLoad: ({ params }) => {
    parseDevTrackIdentity(params);
  },
  component: GeometryRoute,
});
