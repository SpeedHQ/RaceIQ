import { createFileRoute, redirect } from "@tanstack/react-router";
import { TrackViewer } from "../../components/TrackViewer";

type TracksSearch = { track?: number; tab?: string };

export const Route = createFileRoute("/iracing/tracks/")({
  validateSearch: (search: Record<string, unknown>): TracksSearch => ({
    track: search.track != null && search.track !== "" ? Number(search.track) : undefined,
    tab: typeof search.tab === "string" ? search.tab : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (search.track == null || !Number.isFinite(search.track)) return;
    const base = `/iracing/tracks/${search.track}`;
    throw redirect({
      to: search.tab && search.tab !== "info" ? `${base}/${search.tab}` : base,
      replace: true,
    });
  },
  component: TrackViewer,
});
