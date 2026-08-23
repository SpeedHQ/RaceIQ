import { Hono } from "hono";
import { GameIdSchema, type GameId } from "../../../shared/games/ids";
import { cornerNumbers } from "../../../shared/racing/tracks/facts";
import { loadTrackFacts } from "../../../shared/racing/tracks/storage/meta";
import type { TrackFacts } from "../../../shared/racing/tracks/facts";
import { productionTrackGuideStore, validateTrackGuide, type TrackGuideStore } from "../../../shared/racing/tracks/guide/data";
import type { TrackGuideFile, ResolvedTrackGuide } from "../../../shared/racing/tracks/guide/types";
import { resolveTrackGuideFile } from "../../ai/track-guides";
import { getSharedTrackName } from "../tracks/support";

export interface TrackGuideEnvelope {
  gameId: GameId;
  trackOrdinal: number;
  slug: string;
  guide: TrackGuideFile | null;
  resolved: ResolvedTrackGuide | null;
  facts: TrackFacts | null;
}

function selectedTrack(c: { req: { query: (key: string) => string | undefined; param: (key: string) => string } }): { gameId: GameId; trackOrdinal: number } {
  const gameId = GameIdSchema.parse(c.req.query("gameId"));
  const rawOrdinal = c.req.param("ordinal");
  if (!/^(?:0|[1-9]\d*)$/.test(rawOrdinal)) throw new Error("Invalid track ordinal");
  const trackOrdinal = Number(rawOrdinal);
  if (!Number.isSafeInteger(trackOrdinal) || trackOrdinal < 0) throw new Error("Invalid track ordinal");
  return { gameId, trackOrdinal };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to save track guide";
}

function envelope(store: TrackGuideStore, gameId: GameId, trackOrdinal: number, slug: string): TrackGuideEnvelope {
  const facts = loadTrackFacts(slug);
  const guide = store.load(slug);
  return { gameId, trackOrdinal, slug, guide, resolved: guide ? resolveTrackGuideFile(guide, facts) : null, facts };
}

function validateAnchors(guide: TrackGuideFile, facts: TrackFacts | null): void {
  if (!facts) return;
  const known = new Set<number>();
  for (const corner of facts.corners) for (const number of cornerNumbers(corner)) known.add(number);
  for (const corner of guide.corners) {
    for (const number of corner.numbers ?? []) {
      if (!known.has(number)) throw new Error(`corner ${corner.key} references unavailable turn ${number}`);
    }
  }
}

export function createTrackGuideDevRoutes({ store = productionTrackGuideStore }: { store?: TrackGuideStore } = {}): Hono {
  return new Hono()
    .get("/api/dev/track-guides/:ordinal", (c) => {
      try {
        const { gameId, trackOrdinal } = selectedTrack(c);
        const slug = getSharedTrackName(trackOrdinal, gameId);
        if (!slug) return c.json({ error: "Track slug not found for selected track" }, 404);
        return c.json(envelope(store, gameId, trackOrdinal, slug));
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    })
    .put("/api/dev/track-guides/:ordinal", async (c) => {
      try {
        const { gameId, trackOrdinal } = selectedTrack(c);
        const slug = getSharedTrackName(trackOrdinal, gameId);
        if (!slug) return c.json({ error: "Track slug not found for selected track" }, 404);
        const body = (await c.req.json()) as unknown;
        const guide = validateTrackGuide(body, slug);
        if (guide.locale !== "en") throw new Error('locale must be "en"');
        const facts = loadTrackFacts(slug);
        validateAnchors(guide, facts);
        try {
          store.save(guide);
        } catch (error) {
          return c.json({ error: errorMessage(error) }, 500);
        }
        return c.json(envelope(store, gameId, trackOrdinal, slug));
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    });
}

export const trackGuideDevRoutes = createTrackGuideDevRoutes();
