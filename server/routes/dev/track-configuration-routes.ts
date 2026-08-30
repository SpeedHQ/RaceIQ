import { Hono } from "hono";
import { GameIdSchema, type GameId } from "../../../shared/games/ids";
import { TrackConfigurationConfirmationSchema, TrackConfigurationSchema, type TrackConfiguration } from "../../../shared/racing/tracks/configuration";
import { deleteTrackConfiguration, listTrackConfigurations, loadTrackConfiguration, saveTrackConfiguration } from "../../tracks/configuration";

function gameAndTrack(c: { req: { param: (key: string) => string; query: (key: string) => string | undefined } }): { gameId: GameId; trackOrdinal: number } {
  const gameId = GameIdSchema.parse(c.req.query("gameId"));
  const trackOrdinal = Number.parseInt(c.req.param("ordinal"), 10);
  if (!Number.isSafeInteger(trackOrdinal) || trackOrdinal < 0) throw new Error("Invalid track ordinal");
  return { gameId, trackOrdinal };
}

export const trackConfigurationDevRoutes = new Hono()
  .get("/api/dev/track-configurations", (c) => c.json(listTrackConfigurations()))
  .get("/api/dev/track-configurations/:ordinal", (c) => {
    try {
      const { gameId, trackOrdinal } = gameAndTrack(c);
      return c.json(loadTrackConfiguration(gameId, trackOrdinal));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to load track configuration" }, 400);
    }
  })
  .put("/api/dev/track-configurations/:ordinal", async (c) => {
    try {
      const { gameId, trackOrdinal } = gameAndTrack(c);
      const raw = (await c.req.json()) as TrackConfiguration;
      const configuration = TrackConfigurationSchema.parse({
        ...raw,
        version: 1,
        gameId,
        trackOrdinal,
        confirmation: null,
      });
      return c.json(saveTrackConfiguration(configuration));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to save track configuration" }, 400);
    }
  })
  .put("/api/dev/track-configurations/:ordinal/confirmation", async (c) => {
    try {
      const { gameId, trackOrdinal } = gameAndTrack(c);
      const current = loadTrackConfiguration(gameId, trackOrdinal);
      if (!current) return c.json({ error: "Save venue assignment before confirming" }, 404);
      const confirmation = TrackConfigurationConfirmationSchema.parse(await c.req.json());
      return c.json(saveTrackConfiguration({ ...current, confirmation }));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to confirm track configuration" }, 400);
    }
  })
  .delete("/api/dev/track-configurations/:ordinal/confirmation", (c) => {
    try {
      const { gameId, trackOrdinal } = gameAndTrack(c);
      const current = loadTrackConfiguration(gameId, trackOrdinal);
      if (!current) return c.json({ error: "Track configuration not found" }, 404);
      return c.json(saveTrackConfiguration({ ...current, confirmation: null }));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to clear track confirmation" }, 400);
    }
  })
  .delete("/api/dev/track-configurations/:ordinal", (c) => {
    try {
      const { gameId, trackOrdinal } = gameAndTrack(c);
      deleteTrackConfiguration(gameId, trackOrdinal);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to remove track configuration" }, 400);
    }
  });
