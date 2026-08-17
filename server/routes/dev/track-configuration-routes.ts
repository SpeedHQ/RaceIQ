import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Hono } from "hono";
import { GameIdSchema, type GameId } from "../../../shared/games/ids";
import { TrackConfigurationConfirmationSchema, TrackConfigurationSchema, type TrackConfiguration } from "../../../shared/racing/tracks/configuration";
import { listTrackConfigurations, loadTrackConfiguration, trackConfigurationPath } from "../../tracks/configuration";

function gameAndTrack(c: { req: { param: (key: string) => string; query: (key: string) => string | undefined } }): { gameId: GameId; trackOrdinal: number } {
  const gameId = GameIdSchema.parse(c.req.query("gameId"));
  const trackOrdinal = Number.parseInt(c.req.param("ordinal"), 10);
  if (!Number.isSafeInteger(trackOrdinal) || trackOrdinal < 0) throw new Error("Invalid track ordinal");
  return { gameId, trackOrdinal };
}

function writeConfiguration(configuration: TrackConfiguration): void {
  const path = trackConfigurationPath(configuration.gameId, configuration.trackOrdinal);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(configuration, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
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
      writeConfiguration(configuration);
      return c.json(configuration);
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
      const configuration = { ...current, confirmation };
      writeConfiguration(configuration);
      return c.json(configuration);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to confirm track configuration" }, 400);
    }
  })
  .delete("/api/dev/track-configurations/:ordinal/confirmation", (c) => {
    try {
      const { gameId, trackOrdinal } = gameAndTrack(c);
      const current = loadTrackConfiguration(gameId, trackOrdinal);
      if (!current) return c.json({ error: "Track configuration not found" }, 404);
      const configuration = { ...current, confirmation: null };
      writeConfiguration(configuration);
      return c.json(configuration);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to clear track confirmation" }, 400);
    }
  })
  .delete("/api/dev/track-configurations/:ordinal", (c) => {
    try {
      const { gameId, trackOrdinal } = gameAndTrack(c);
      const path = trackConfigurationPath(gameId, trackOrdinal);
      if (existsSync(path)) unlinkSync(path);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to remove track configuration" }, 400);
    }
  });
