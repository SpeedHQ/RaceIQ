import { createFileRoute, Link, Outlet, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { parseDevTrackIdentity } from "../lib/dev-track-routes";
import { trackConfigurationCanonicalId, type TrackConfiguration } from "../../../shared/racing/tracks/configuration";
import { buttonVariants } from "../components/ui/button";
import { useGameStore } from "../stores/game";
import { client, devClient } from "../lib/rpc";

interface CatalogTrack {
  ordinal: number;
  name: string;
  variant?: string | null;
}

function SelectedTrackWorkbench() {
  const params = useParams({ from: "/dev/tracks/$gameId/$trackOrdinal" });
  const { gameId, trackOrdinal } = parseDevTrackIdentity(params);
  const setGameId = useGameStore((state) => state.setGameId);
  const trackQuery = useQuery({
    queryKey: ["tracks", gameId],
    queryFn: async () => {
      const response = await client.api.tracks.$get({ query: { gameId } });
      if (!response.ok) throw new Error("Unable to load track catalog");
      return (await response.json()) as CatalogTrack[];
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
  const configurationQuery = useQuery({
    queryKey: ["track-configurations"],
    queryFn: async () => {
      const response = await devClient.api.dev["track-configurations"].$get();
      if (!response.ok) throw new Error("Unable to load track configurations");
      return (await response.json()) as TrackConfiguration[];
    },
  });
  const catalogTrack = trackQuery.data?.find((track) => track.ordinal === trackOrdinal);
  const configuration = configurationQuery.data?.find((entry) => entry.gameId === gameId && entry.trackOrdinal === trackOrdinal) ?? null;

  useEffect(() => {
    setGameId(gameId);
    return () => setGameId(null);
  }, [gameId, setGameId]);

  const links = [
    { key: "overview", label: "Overview", to: "/dev/tracks/$gameId/$trackOrdinal" },
    { key: "turns", label: "Geometry", to: "/dev/tracks/$gameId/$trackOrdinal/geometry" },
    { key: "guides", label: "Guides", to: "/dev/tracks/$gameId/$trackOrdinal/guides" },
    { key: "imagery", label: "Imagery", to: "/dev/tracks/$gameId/$trackOrdinal/imagery" },
  ] as const;

  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-app-border bg-app-surface px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-mono text-xs text-app-text-muted">
              {gameId} · ordinal {trackOrdinal}
            </p>
            <h2 className="text-lg font-semibold text-app-text">{catalogTrack?.name ?? "Selected track workbench"}</h2>
            <p className="text-sm text-app-text-muted">
              {catalogTrack?.variant || "Main"}
              {configuration ? ` · ${trackConfigurationCanonicalId(configuration)}` : ""}
            </p>
            {configuration?.confirmation ? (
              <p className="text-xs text-app-text-muted">
                Confirmed {configuration.confirmation.confirmedAt} by {configuration.confirmation.confirmedBy}
              </p>
            ) : (
              <p className="text-xs text-app-text-muted">{configuration ? "Needs confirmation" : "Unassigned"}</p>
            )}
          </div>
          <Link to="/dev/tracks" className="text-sm text-app-accent hover:underline">
            Change track
          </Link>
        </div>
        <nav aria-label="Track tools" className="mt-3 flex flex-wrap gap-1">
          {links.map((link) => (
            <Link
              key={link.key}
              to={link.to}
              params={{ gameId, trackOrdinal: String(trackOrdinal) }}
              activeOptions={{ exact: link.key === "overview" }}
              activeProps={{ "aria-current": "page" }}
              className={buttonVariants({ variant: "outline", size: "sm", className: "text-app-text-muted [&.active]:border-app-accent [&.active]:text-app-accent" })}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/dev/tracks/$gameId/$trackOrdinal")({
  beforeLoad: ({ params }) => {
    parseDevTrackIdentity(params);
  },
  component: SelectedTrackWorkbench,
});
