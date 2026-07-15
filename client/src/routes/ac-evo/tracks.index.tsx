import { createFileRoute, redirect } from "@tanstack/react-router";
import { TrackViewer } from "../../components/TrackViewer";

type TracksSearch = { track?: number; tab?: string };

/**
 * The track gallery.
 *
 * Track detail used to live here behind ?track=<ordinal>&tab=<tab>; it's now
 * its own route. Old links still work — they redirect to the new path rather
 * than silently dropping the user on the gallery.
 */
export const Route = createFileRoute("/ac-evo/tracks/")({
  validateSearch: (search: Record<string, unknown>): TracksSearch => ({
    track: search.track != null && search.track !== "" ? Number(search.track) : undefined,
    tab: typeof search.tab === "string" ? search.tab : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (search.track == null || !Number.isFinite(search.track)) return;
    const base = `/ac-evo/tracks/${search.track}`;
    throw redirect({ to: search.tab && search.tab !== "info" ? `${base}/${search.tab}` : base, replace: true });
  },
  component: TrackViewer,
});
