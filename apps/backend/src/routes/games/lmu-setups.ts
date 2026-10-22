import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { SaveLMUSetupInput } from "../../setups/lmu";
import { getLMUSetupContent, listLMUSetups, saveLMUSetup } from "../../setups/lmu";

const SaveSchema: z.ZodType<SaveLMUSetupInput> = z.object({
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("file"), path: z.string().min(1).max(1024), sha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }).strict(),
    z.object({ kind: z.literal("upload"), contentBase64: z.string().max(1_400_000), trackFolder: z.string().max(1024) }).strict(),
  ]),
  fileName: z.string().min(1).max(1024),
  edits: z.array(z.object({ id: z.string().min(1).max(256), delta: z.number().int().safe() }).strict()).max(512),
}).strict();

export const lmuSetupRoutes = new Hono()
  .get("/api/lmu/setups", async (c) => c.json(await listLMUSetups()))
  .get("/api/lmu/setup-content", zValidator("query", z.object({ path: z.string().min(1).max(1024) })), async (c) => {
    const result = await getLMUSetupContent(c.req.valid("query").path);
    return result.ok ? c.json(result.value) : c.json({ error: result.error }, result.status);
  })
  .post("/api/lmu/save-setup", bodyLimit({ maxSize: 2 * 1024 * 1024 }), zValidator("json", SaveSchema), async (c) => {
    const result = await saveLMUSetup(c.req.valid("json"));
    return result.ok ? c.json(result.value, 201) : c.json({ error: result.error }, result.status);
  });
