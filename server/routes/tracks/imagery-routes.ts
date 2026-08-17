import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { GameIdSchema } from "../../../shared/games/ids";
import { OrdinalParamSchema } from "../../../shared/platform/http/route-schemas";
import { loadTrackImagery, trackImageryContentType } from "../../tracks/imagery";

const TrackImageryQuerySchema = z.object({ gameId: GameIdSchema });
const TrackImageryTextureParamSchema = OrdinalParamSchema.extend({ textureId: z.string().regex(/^(?:base|[a-z0-9][a-z0-9-]*)$/) });

export const trackImageryRoutes = new Hono()
  .get("/api/track-imagery/:ordinal", zValidator("param", OrdinalParamSchema), zValidator("query", TrackImageryQuerySchema), (c) => {
    const { ordinal } = c.req.valid("param");
    const { gameId } = c.req.valid("query");
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) return c.json({ error: "Invalid track ordinal" }, 400);
    const loaded = loadTrackImagery(gameId, ordinal);
    return c.json(loaded?.imagery ?? null);
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
        "Content-Type": trackImageryContentType(texture.path),
        ETag: `"${Math.round(texture.modifiedAtMs)}"`,
      },
    });
  });
