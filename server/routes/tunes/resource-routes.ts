import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { IdParamSchema } from "@shared/platform/http/route-schemas";
import { GameIdSchema } from "../../../shared/games/ids";
import type { GameId } from "../../../shared/games/ids";
import { getCommunityTuneById } from "../../db/community-tune-queries";
import { deleteTune, getTuneById, getTunes, insertTune, updateTune } from "../../db/tune-queries";
import {
  CarIdQuerySchema,
  communityRowToCatalog,
  parseTuneRow,
  validateSettingsForGame,
} from "../tune-shared";

const CreateTuneSchema = z.object({
  gameId: GameIdSchema,
  name: z.string().min(1),
  author: z.string().min(1),
  carId: z.string().min(1),
  category: z.string().min(1),
  settings: z.record(z.string(), z.unknown()),
  trackId: z.string().min(1).optional(),
  description: z.string().optional().default(""),
  strengths: z.array(z.string()).optional(),
  weaknesses: z.array(z.string()).optional(),
  bestTracks: z.array(z.string()).optional(),
  strategies: z.array(z.unknown()).optional(),
  unitSystem: z.enum(["metric", "imperial"]).optional().default("metric"),
  source: z.enum(["user", "catalog-clone", "imported-file"]).optional().default("user"),
  catalogId: z.string().optional(),
});

// All CreateTuneSchema fields optional, minus gameId — a tune's game must not
// be changeable via update.
const UpdateTuneSchema = CreateTuneSchema.omit({ gameId: true }).partial();

async function createTune(body: z.infer<typeof CreateTuneSchema>) {
  if (!validateSettingsForGame(body.gameId, body.settings)) return null;

  const id = await insertTune({
    gameId: body.gameId,
    name: body.name,
    author: body.author,
    carId: body.carId,
    category: body.category,
    trackId: body.trackId,
    description: body.description,
    strengths: body.strengths ? JSON.stringify(body.strengths) : undefined,
    weaknesses: body.weaknesses ? JSON.stringify(body.weaknesses) : undefined,
    bestTracks: body.bestTracks ? JSON.stringify(body.bestTracks) : undefined,
    strategies: body.strategies ? JSON.stringify(body.strategies) : undefined,
    settings: JSON.stringify(body.settings),
    unitSystem: body.unitSystem,
    source: body.source,
    catalogId: body.catalogId,
  });
  return parseTuneRow(await getTuneById(id));
}

export const tuneResourceRoutes = new Hono()
  .get("/api/tunes", zValidator("query", CarIdQuerySchema), async (c) => {
    const { gameId, carId } = c.req.valid("query");
    const rows = await getTunes({ gameId, carId });
    return c.json(rows.map(parseTuneRow));
  })

  // GET /api/tunes/:id — static routes are mounted before this module.
  .get("/api/tunes/:id", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const row = await getTuneById(id);
    if (!row) return c.json({ error: "Tune not found" }, 404);
    return c.json(parseTuneRow(row));
  })

  .post("/api/tunes", zValidator("json", CreateTuneSchema), async (c) => {
    const created = await createTune(c.req.valid("json"));
    if (!created) return c.json({ error: "Invalid settings structure" }, 400);
    return c.json(created, 201);
  })

  .put("/api/tunes/:id", zValidator("param", IdParamSchema), zValidator("json", UpdateTuneSchema), async (c) => {
    const { id } = c.req.valid("param");
    const existing = await getTuneById(id);
    if (!existing) return c.json({ error: "Tune not found" }, 404);
    const body = c.req.valid("json");
    if (body.settings && !validateSettingsForGame(existing.gameId as GameId, body.settings))
      return c.json({ error: "Invalid settings structure" }, 400);
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.author !== undefined) data.author = body.author;
    if (body.carId !== undefined) data.carId = body.carId;
    if (body.category !== undefined) data.category = body.category;
    if (body.trackId !== undefined) data.trackId = body.trackId;
    if (body.description !== undefined) data.description = body.description;
    if (body.strengths !== undefined) data.strengths = JSON.stringify(body.strengths);
    if (body.weaknesses !== undefined) data.weaknesses = JSON.stringify(body.weaknesses);
    if (body.bestTracks !== undefined) data.bestTracks = JSON.stringify(body.bestTracks);
    if (body.strategies !== undefined) data.strategies = JSON.stringify(body.strategies);
    if (body.settings !== undefined) data.settings = JSON.stringify(body.settings);
    if (body.unitSystem !== undefined) data.unitSystem = body.unitSystem;
    const updated = await updateTune(id, data);
    if (!updated) return c.json({ error: "Tune not found" }, 404);
    return c.json(parseTuneRow(await getTuneById(id)));
  })

  .delete("/api/tunes/:id", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    if (!(await deleteTune(id))) return c.json({ error: "Tune not found" }, 404);
    return c.json({ success: true });
  })

  .post("/api/tunes/import", zValidator("json", CreateTuneSchema), async (c) => {
    const created = await createTune(c.req.valid("json"));
    if (!created) return c.json({ error: "Invalid settings structure" }, 400);
    return c.json(created, 201);
  })

  .post("/api/tunes/clone/:catalogId", async (c) => {
    const catalogId = c.req.param("catalogId");
    const catalogTune = await getCommunityTuneById(catalogId).then((row) =>
      row ? communityRowToCatalog(row) : undefined,
    );
    if (!catalogTune) return c.json({ error: "Catalog tune not found" }, 404);
    const id = await insertTune({
      gameId: catalogTune.gameId,
      name: `${catalogTune.name} (copy)`,
      author: catalogTune.author,
      carId: catalogTune.carId,
      category: catalogTune.category,
      trackId: catalogTune.trackId,
      description: catalogTune.description,
      strengths: JSON.stringify(catalogTune.strengths ?? []),
      weaknesses: JSON.stringify(catalogTune.weaknesses ?? []),
      bestTracks: JSON.stringify(catalogTune.bestTracks ?? []),
      strategies: JSON.stringify(catalogTune.strategies ?? []),
      settings: JSON.stringify(catalogTune.settings),
      unitSystem: "metric",
      source: "catalog-clone",
      catalogId: catalogTune.id,
    });
    return c.json(parseTuneRow(await getTuneById(id)), 201);
  })

  .post("/api/tunes/:id/duplicate", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const existing = await getTuneById(id);
    if (!existing) return c.json({ error: "Tune not found" }, 404);
    const newId = await insertTune({
      gameId: existing.gameId,
      name: `${existing.name} (copy)`,
      author: existing.author,
      carId: existing.carId,
      category: existing.category,
      trackId: existing.trackId ?? undefined,
      description: existing.description,
      strengths: existing.strengths ?? undefined,
      weaknesses: existing.weaknesses ?? undefined,
      bestTracks: existing.bestTracks ?? undefined,
      strategies: existing.strategies ?? undefined,
      settings: existing.settings,
      unitSystem: existing.unitSystem,
      source: existing.source,
      catalogId: existing.catalogId ?? undefined,
    });
    return c.json(parseTuneRow(await getTuneById(newId)), 201);
  });
