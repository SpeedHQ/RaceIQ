import { zValidator } from "@hono/zod-validator";
import { GameIdSchema } from "@shared/games/ids";
import { Hono } from "hono";
import { z } from "zod";
import { getBaseTrackImagePath, saveBaseTrackImage } from "../../tracks/imagery";

const MAX_BASE_TRACK_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES: Record<string, true> = { "image/jpeg": true, "image/png": true, "image/webp": true, "image/avif": true };
const BaseTrackImageQuerySchema = z.object({
  gameId: GameIdSchema,
  baseTrackName: z.string().trim().min(1).max(200),
  v: z.string().optional(),
});

export const trackImageryRoutes = new Hono()
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
