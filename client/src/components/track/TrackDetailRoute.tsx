import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback } from "react";
import { useTracks } from "@/hooks/queries";
import { trackRoutePath, tracksIndexPath } from "@/lib/track-routes";
import { m } from "@/paraglide/messages";
import { useGameId } from "@/stores/game";
import { TrackDetail } from "./TrackDetail";
import type { TrackInfo } from "./types";

/**
 * Renders a track's detail view for a tab route.
 *
 * Every `/<game>/tracks/<ordinal>/<tab>` route renders this with its own tab —
 * the URL is the single source of truth for which tab is open, so back/forward
 * work per tab and any tab can be linked to directly.
 */
export function TrackDetailRoute({ tab }: { tab: string }) {
  const navigate = useNavigate();
  const gameId = useGameId();
  const params = useParams({ strict: false }) as { trackOrdinal?: string };
  const ordinal = params.trackOrdinal != null ? Number(params.trackOrdinal) : Number.NaN;

  const { data: tracks = [], isLoading } = useTracks() as { data: TrackInfo[]; isLoading: boolean };
  const track = tracks.find((t) => t.ordinal === ordinal) ?? null;

  const onTabChange = useCallback(
    (next: string) => {
      if (!gameId || !Number.isFinite(ordinal)) return;
      navigate({ to: trackRoutePath(gameId, ordinal, next), replace: true });
    },
    [navigate, gameId, ordinal],
  );

  const onBack = useCallback(() => {
    if (!gameId) return;
    navigate({ to: tracksIndexPath(gameId) });
  }, [navigate, gameId]);

  if (isLoading) return <div className="p-4 text-app-text-dim">{m.trackviewer_loading()}</div>;
  if (!track) return <div className="p-4 text-app-text-dim">{m.trackdetailroute_not_found()}</div>;

  return <TrackDetail track={track} onBack={onBack} tab={tab} onTabChange={onTabChange} />;
}
