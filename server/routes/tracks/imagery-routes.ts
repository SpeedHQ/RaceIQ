import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { GameIdSchema } from "../../../shared/games/ids";
import { OrdinalParamSchema } from "../../../shared/platform/http/route-schemas";
import { loadTrackImagery } from "../../tracks/imagery";
import { readTrackImageryPackTile } from "../../tracks/imagery-pack";

const TrackImageryQuerySchema = z.object({ gameId: GameIdSchema });
const TrackImageryTextureParamSchema = OrdinalParamSchema.extend({ textureId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) });
const TrackImageryTileParamSchema = OrdinalParamSchema.extend({
  x: z.string().regex(/^(?:0|[1-9]\d*)$/),
  y: z.string().regex(/^(?:0|[1-9]\d*)$/),
});

export const trackImageryRoutes = new Hono()
  .get("/api/track-imagery/:ordinal", zValidator("param", OrdinalParamSchema), zValidator("query", TrackImageryQuerySchema), (c) => {
    const { ordinal } = c.req.valid("param");
    const { gameId } = c.req.valid("query");
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) return c.json({ error: "Invalid track ordinal" }, 400);
    const loaded = loadTrackImagery(gameId, ordinal);
    return c.json(loaded?.imagery ?? null);
  })
  .get("/api/track-imagery/:ordinal/base/hq/:x/:y", zValidator("param", TrackImageryTileParamSchema), zValidator("query", TrackImageryQuerySchema), (c) => {
    const { ordinal, x, y } = c.req.valid("param");
    const { gameId } = c.req.valid("query");
    const tileX = Number(x);
    const tileY = Number(y);
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || !Number.isSafeInteger(tileX) || !Number.isSafeInteger(tileY)) return c.json({ error: "Invalid imagery tile coordinate" }, 400);
    const loaded = loadTrackImagery(gameId, ordinal);
    if (!loaded) return c.json({ error: "Track imagery not found" }, 404);
    const tile = readTrackImageryPackTile(loaded.packPath, tileX, tileY, loaded.packMetadata);
    if (!tile) return c.json({ error: "Track imagery tile not found" }, 404);
    return new Response(Uint8Array.from(tile.data).buffer, {
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": "image/webp",
        ETag: `"${loaded.imagery.base.contentHash}-${tileX}-${tileY}"`,
      },
    });
  })
  .get("/api/track-imagery/:ordinal/texture/:textureId", zValidator("param", TrackImageryTextureParamSchema), zValidator("query", TrackImageryQuerySchema), (c) => {
    const { ordinal, textureId } = c.req.valid("param");
    const { gameId } = c.req.valid("query");
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) return c.json({ error: "Invalid track ordinal" }, 400);
    const loaded = loadTrackImagery(gameId, ordinal);
    const texture = loaded?.textures[textureId];
    if (!texture) return c.json({ error: "Track imagery texture not found" }, 404);
    return new Response(Bun.file(texture.path), {
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": texture.path.toLowerCase().endsWith(".png") ? "image/png" : texture.path.toLowerCase().endsWith(".webp") ? "image/webp" : "image/jpeg",
        ETag: `"${Math.round(texture.modifiedAtMs)}"`,
      },
    });
  });
