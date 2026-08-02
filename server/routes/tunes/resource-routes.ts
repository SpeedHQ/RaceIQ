import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { IdParamSchema } from "../../../shared/schemas";
import { GameIdSchema } from "../../../shared/types";
import type { GameId } from "../../../shared/types";
import { getCommunityTuneById } from "../../db/community-tune-queries";
import { deleteTune, getTuneById, getTunes, insertTune, updateTune } from "../../db/tune-queries";
import {
  CarOrdinalQuerySchema,
  communityRowToCatalog,
  parseTuneRow,
  validateSettingsForGame,
} from "../tune-shared";

const CreateTuneSchema = z.object({
  gameId: GameIdSchema,
  name: z.string().min(1),
  author: z.string().min(1),
  carOrdinal: z.number().int(),
  category: z.string().min(1),
  settings: z.record(z.string(), z.unknown()),
  trackOrdinal: z.number().int().optional(),
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

export const tuneResourceRoutes = new Hono()
  // GET /api/tunes — list user tunes, optional ?gameId= and ?carOrdinal= filters
  .get(
    "/api/tunes",
    zValidator("query", CarOrdinalQuerySchema),
    async (c) => {
      const { gameId, carOrdinal } = c.req.valid("query");
      const rows = await getTunes({ gameId, carOrdinal });
      return c.json(rows.map(parseTuneRow));
    },
  )

  // GET /api/tunes/:id — get single tune. Static /api/tunes/* GET routes are
  // mounted before this module by tunes/index.ts so they cannot be swallowed.
  .get(
    "/api/tunes/:id",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const row = await getTuneById(id);
      if (!row) return c.json({ error: "Tune not found" }, 404);
      return c.json(parseTuneRow(row));
    },
  )

  // POST /api/tunes — create tune
  .post(
    "/api/tunes",
    zValidator("json", CreateTuneSchema),
    async (c) => {
      const body = c.req.valid("json");
      if (!validateSettingsForGame(body.gameId, body.settings)) {
        return c.json({ error: "Invalid settings structure" }, 400);
      }
      const id = await insertTune({
        gameId: body.gameId,
        name: body.name,
        author: body.author,
        carOrdinal: body.carOrdinal,
        category: body.category,
        trackOrdinal: body.trackOrdinal,
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
      const created = await getTuneById(id);
      return c.json(parseTuneRow(created), 201);
    },
  )

  // PUT /api/tunes/:id — update tune
  .put(
    "/api/tunes/:id",
    zValidator("param", IdParamSchema),
    zValidator("json", UpdateTuneSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const existing = await getTuneById(id);
      if (!existing) return c.json({ error: "Tune not found" }, 404);

      const body = c.req.valid("json");
      if (body.settings && !validateSettingsForGame(existing.gameId as GameId, body.settings)) {
        return c.json({ error: "Invalid settings structure" }, 400);
      }
      const data: Record<string, any> = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.author !== undefined) data.author = body.author;
      if (body.carOrdinal !== undefined) data.carOrdinal = body.carOrdinal;
      if (body.category !== undefined) data.category = body.category;
      if (body.trackOrdinal !== undefined) data.trackOrdinal = body.trackOrdinal;
      if (body.description !== undefined) data.description = body.description;
      if (body.strengths !== undefined) data.strengths = JSON.stringify(body.strengths);
      if (body.weaknesses !== undefined) data.weaknesses = JSON.stringify(body.weaknesses);
      if (body.bestTracks !== undefined) data.bestTracks = JSON.stringify(body.bestTracks);
      if (body.strategies !== undefined) data.strategies = JSON.stringify(body.strategies);
      if (body.settings !== undefined) data.settings = JSON.stringify(body.settings);
      if (body.unitSystem !== undefined) data.unitSystem = body.unitSystem;
      const updated = await updateTune(id, data);
      if (!updated) return c.json({ error: "Tune not found" }, 404);
      const row = await getTuneById(id);
      return c.json(parseTuneRow(row));
    },
  )

  // DELETE /api/tunes/:id — delete tune
  .delete(
    "/api/tunes/:id",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const deleted = await deleteTune(id);
      if (!deleted) return c.json({ error: "Tune not found" }, 404);
      return c.json({ success: true });
    },
  )

  // POST /api/tunes/import — same as POST /api/tunes (batch-ish helper, kept for
  // compatibility with the JSON paste flow in TuneForm)
  .post(
    "/api/tunes/import",
    zValidator("json", CreateTuneSchema),
    async (c) => {
      const body = c.req.valid("json");
      if (!validateSettingsForGame(body.gameId, body.settings)) {
        return c.json({ error: "Invalid settings structure" }, 400);
      }
      const id = await insertTune({
        gameId: body.gameId,
        name: body.name,
        author: body.author,
        carOrdinal: body.carOrdinal,
        category: body.category,
        trackOrdinal: body.trackOrdinal,
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
      const created = await getTuneById(id);
      return c.json(parseTuneRow(created), 201);
    },
  )

  // POST /api/tunes/clone/:catalogId — clone a catalog tune into DB (Forza only)
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
      carOrdinal: catalogTune.carOrdinal,
      category: catalogTune.category,
      trackOrdinal: catalogTune.trackOrdinal,
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

    const created = await getTuneById(id);
    return c.json(parseTuneRow(created), 201);
  })

  // POST /api/tunes/:id/duplicate — clone an existing user tune into a fresh row
  .post(
    "/api/tunes/:id/duplicate",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const existing = await getTuneById(id);
      if (!existing) return c.json({ error: "Tune not found" }, 404);

      const newId = await insertTune({
        gameId: existing.gameId,
        name: `${existing.name} (copy)`,
        author: existing.author,
        carOrdinal: existing.carOrdinal,
        category: existing.category,
        trackOrdinal: existing.trackOrdinal ?? undefined,
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
      const created = await getTuneById(newId);
      return c.json(parseTuneRow(created), 201);
    },
  );
