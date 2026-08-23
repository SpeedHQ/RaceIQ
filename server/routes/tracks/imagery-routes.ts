import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { GameIdSchema } from "../../../shared/games/ids";
import { OrdinalParamSchema } from "../../../shared/platform/http/route-schemas";
import { getBaseTrackImagePath, loadTrackImagery, saveBaseTrackImage } from "../../tracks/imagery";
import { readTrackImageryPackTile } from "../../tracks/imagery-pack";

const TrackImageryQuerySchema = z.object({ gameId: GameIdSchema });
const TrackImageryTextureParamSchema = OrdinalParamSchema.extend({ textureId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) });
const TrackImageryTileParamSchema = OrdinalParamSchema.extend({
  x: z.string().regex(/^(?:0|[1-9]\d*)$/),
  y: z.string().regex(/^(?:0|[1-9]\d*)$/),
});

const MAX_BASE_TRACK_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES: Record<string, true> = {
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
  "image/avif": true,
};
const BaseTrackImageQuerySchema = z.object({
  gameId: GameIdSchema,
  baseTrackName: z.string().trim().min(1).max(200),
  v: z.string().optional(),
});

export const trackImageryRoutes = new Hono()
  .get("/api/track-imagery/:ordinal", zValidator("param", OrdinalParamSchema), zValidator("query", TrackImageryQuerySchema), async (c) => {
    const { ordinal } = c.req.valid("param");
    const { gameId } = c.req.valid("query");
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) return c.json({ error: "Invalid track ordinal" }, 400);
    const loaded = await loadTrackImagery(gameId, ordinal);
    return c.json(loaded?.imagery ?? null);
  })
  .get("/api/track-imagery/:ordinal/base/hq/:x/:y", zValidator("param", TrackImageryTileParamSchema), zValidator("query", TrackImageryQuerySchema), async (c) => {
    const { ordinal, x, y } = c.req.valid("param");
    const { gameId } = c.req.valid("query");
    const tileX = Number(x);
    const tileY = Number(y);
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || !Number.isSafeInteger(tileX) || !Number.isSafeInteger(tileY)) return c.json({ error: "Invalid imagery tile coordinate" }, 400);
    const loaded = await loadTrackImagery(gameId, ordinal);
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
  .get("/api/track-imagery/:ordinal/texture/:textureId", zValidator("param", TrackImageryTextureParamSchema), zValidator("query", TrackImageryQuerySchema), async (c) => {
    const { ordinal, textureId } = c.req.valid("param");
    const { gameId } = c.req.valid("query");
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) return c.json({ error: "Invalid track ordinal" }, 400);
    const loaded = await loadTrackImagery(gameId, ordinal);
    const texture = loaded?.textures[textureId];
    if (!texture) return c.json({ error: "Track imagery texture not found" }, 404);
    return new Response(Bun.file(texture.path), {
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": texture.path.toLowerCase().endsWith(".png") ? "image/png" : texture.path.toLowerCase().endsWith(".webp") ? "image/webp" : "image/jpeg",
        ETag: `"${Math.round(texture.modifiedAtMs)}"`,
      },
    });
  })
  .get("/api/track-base-image", zValidator("query", BaseTrackImageQuerySchema), async (c) => {
    const { gameId, baseTrackName } = c.req.valid("query");
    const image = Bun.file(getBaseTrackImagePath(gameId, baseTrackName));
    if (!(await image.exists())) return c.json({ error: "Base track image not found" }, 404);

    return new Response(image, {
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": "image/webp",
      },
    });
  })
  .post("/api/track-base-image", zValidator("query", BaseTrackImageQuerySchema), async (c) => {
    const { gameId, baseTrackName } = c.req.valid("query");
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "Missing 'file' in multipart body" }, 400);
    if (!SUPPORTED_IMAGE_TYPES[file.type]) return c.json({ error: "Expected a JPEG, PNG, WebP, or AVIF image" }, 400);
    if (file.size === 0 || file.size > MAX_BASE_TRACK_IMAGE_BYTES) return c.json({ error: "Image must be between 1 byte and 20 MB" }, 400);

    try {
      const imageUrl = await saveBaseTrackImage(gameId, baseTrackName, await file.arrayBuffer());
      return c.json({ imageUrl });
    } catch {
      return c.json({ error: "Image could not be decoded" }, 400);
    }
  });
