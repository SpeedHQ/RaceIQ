import type { GameId } from "@shared/games/ids";
import type { TrackFacts } from "@shared/racing/tracks/facts";
import type { ResolvedTrackGuide, TrackGuideFile } from "@shared/racing/tracks/guide/types";

export interface TrackGuideEnvelope {
  gameId: GameId;
  trackOrdinal: number;
  slug: string;
  guide: TrackGuideFile | null;
  resolved: ResolvedTrackGuide | null;
  facts: TrackFacts | null;
}

export type TrackGuideDraft = TrackGuideFile;

export const publicTrackGuideQueryKey = (trackOrdinal: number, gameId: GameId) => ["track-guide", trackOrdinal, gameId] as const;

export function cloneTrackGuide(guide: TrackGuideFile): TrackGuideDraft {
  return {
    id: guide.id,
    locale: guide.locale,
    character: guide.character,
    sources: guide.sources,
    notes: guide.notes,
    corners: guide.corners.map((corner) => ({
      ...corner,
      numbers: corner.numbers ? [...corner.numbers] : undefined,
    })),
    priorityCorners: [...guide.priorityCorners],
  };
}

export function emptyTrackGuide(slug: string): TrackGuideDraft {
  return { id: slug, locale: "en", character: "", corners: [], priorityCorners: [] };
}
