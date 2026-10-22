import { useCallback } from "react";
import { useTracksCatalogueHost } from "../host";
import { TrackDetail } from "./TrackDetail";

/**
 * Renders a track's detail view for a tab route.
 *
 * Every `/<game>/tracks/<trackId>/<tab>` route renders this with its own tab —
 * the URL is the single source of truth for which tab is open, so back/forward
 * work per tab and any tab can be linked to directly.
 */
export function TrackDetailRoute({ tab }: { tab: string }) {
  const { useNavigate, useParams, useTracks, trackRoutePath, tracksIndexPath, m, useGameId } = useTracksCatalogueHost();
  const navigate = useNavigate();
  const gameId = useGameId();
  const params = useParams({ strict: false });
  const trackKey = params.trackId ?? "";
  const { data: tracks = [], isLoading } = useTracks();
  const track = tracks.find((t) => t.id === trackKey) ?? null;

  const onTabChange = useCallback(
    (next: string) => {
      if (!gameId) return;
      const routeKey = track?.id ?? trackKey;
      if (!routeKey) return;
      navigate({ to: trackRoutePath(gameId, routeKey, next), replace: true });
    },
    [navigate, gameId, trackKey, track?.id],
  );

  const onBack = useCallback(() => {
    if (!gameId) return;
    navigate({ to: tracksIndexPath(gameId) });
  }, [navigate, gameId]);

  if (isLoading) return <div className="p-4 text-app-text-dim">{m.trackviewer_loading()}</div>;
  if (!track) return <div className="p-4 text-app-text-dim">{m.trackdetailroute_not_found()}</div>;

  return <TrackDetail track={track} onBack={onBack} tab={tab} onTabChange={onTabChange} />;
}
