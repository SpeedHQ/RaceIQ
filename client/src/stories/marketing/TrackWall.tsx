import type { ReactNode } from "react";
import { TRACK_CARD_SHELL_CLASS, TrackCardVisual } from "../../components/track/TrackCard";
import type { TrackInfo } from "../../components/track/types";
import fixture from "./track-wall.generated.json" with { type: "json" };

type WallTrack = (typeof fixture.tracks)[number];

const wallTracks = fixture.tracks
  .filter((track) => track.mapKind !== "none" && !/\blegacy\b/i.test(`${track.name} ${track.variant} ${track.location}`))
  .filter((track, index, tracks) => tracks.findIndex((candidate) => candidate.name === track.name) === index);

function trackInfo(track: WallTrack): TrackInfo {
  return {
    ordinal: track.ordinal,
    name: track.name,
    location: track.location,
    country: track.country,
    variant: track.variant,
    lengthKm: track.lengthKm,
    category: track.category,
    hasOutline: track.mapKind === "inline-svg",
    hasMap: track.mapKind !== "none",
    mapUrl: track.mapSrc,
    createdAt: null,
    lapCount: track.lapCount,
  };
}

function mapFor(track: WallTrack): ReactNode {
  if (!track.mapSrc) return undefined;
  return <img src={track.mapSrc} alt={`${track.name} ${track.variant} map`} className="w-full h-full object-contain p-3" loading="lazy" decoding="async" onError={(event) => {
    const fallback = document.createElement("div");
    fallback.className = "flex items-center justify-center h-full text-app-subtext text-app-text-dim";
    fallback.textContent = "No outline available";
    event.currentTarget.replaceWith(fallback);
  }} />;
}

export function TrackWall() {
  return (
    <main
      data-marketing-track-wall
      data-track-count={wallTracks.length}
      data-synthetic="true"
      aria-label={`RaceIQ track wall with ${wallTracks.length} unique venues and synthetic setup and lap counts`}
      className="h-[100dvh] overflow-hidden bg-app-bg text-app-text font-sans relative"
    >
      <div
        tabIndex={0}
        aria-label="Scroll through all track layouts"
        className="h-full overflow-y-auto overscroll-contain [scrollbar-gutter:stable] focus:outline-none focus-visible:ring-1 focus-visible:ring-app-accent"
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2 p-3 pt-12">
          {wallTracks.map((track) => (
            <article key={track.key} data-track-key={track.key} data-game-id={track.gameId} className={TRACK_CARD_SHELL_CLASS}>
              <TrackCardVisual
                track={trackInfo(track)}
                map={mapFor(track)}
                setupCount={track.setupCount}
                guideCount={track.lapCount}
              />
            </article>
          ))}
        </div>
      </div>
    </main>
  );
}
