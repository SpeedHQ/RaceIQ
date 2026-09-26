import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { IdParamSchema } from "@shared/platform/http/route-schemas";
import { GameIdSchema } from "../../shared/games/ids";
import { setTuneAssignment, getTuneAssignment, getTuneAssignments, deleteTuneAssignment, updateLapTune } from "../db/tune-queries";
import type { GameId } from "../../shared/games/ids";
import { getCommunityTunes } from "../db/community-tune-queries";
import { syncCommunityTunes } from "../tunes/community-sync";
import { ensureLaptimesReady, getLaptimes, syncLaptimes } from "../sync/laptimes";
import { communityRowToCatalog, CarIdQuerySchema } from "./tune-shared";

const AssignmentParamsSchema = z.object({
  carId: z.string(),
  trackId: z.string(),
});

const SetAssignmentSchema = z.object({
  gameId: GameIdSchema,
  carId: z.string(),
  trackId: z.string(),
  tuneId: z.number().int(),
});


const AssignmentQuerySchema = z.object({
  gameId: GameIdSchema,
});


const LapTuneSchema = z.object({
  tuneId: z.number().int().nullable(),
});

export const tuneCatalogRoutes = new Hono()
  .get("/api/catalog/tunes",
    zValidator("query", CarIdQuerySchema),
    async (c) => {
      const { carId } = c.req.valid("query");
      const gameId = c.req.header("x-game-id") as GameId | undefined;

      const communityRows = gameId ? await getCommunityTunes(gameId) : [];
      const tunes = communityRows.map(communityRowToCatalog);

      if (carId !== undefined) {
        return c.json(tunes.filter((t) => t.carId === carId));
      }
      return c.json(tunes);
    }
  )

  // POST /api/tunes/community/refresh — force a CDN sync now
  .post("/api/tunes/community/refresh", async (c) => {
    const result = await syncCommunityTunes({ force: true });
    return c.json(result);
  })

  // GET /api/laptimes — community leaderboard reference lap times for the game
  // named in the X-Game-Id header (no fallback: without a header, no times).
  .get("/api/laptimes", async (c) => {
    const gameId = c.req.header("x-game-id") as GameId | undefined;
    if (!gameId) return c.json([]);
    await ensureLaptimesReady();
    return c.json(getLaptimes(gameId));
  })

  // POST /api/laptimes/refresh — force a CDN sync now
  .post("/api/laptimes/refresh", async (c) => {
    const result = await syncLaptimes({ force: true });
    return c.json(result);
  })

  // ─── Assignments ─────────────────────────────────────────────────────────────

  // GET /api/tune-assignments — list all, optional ?gameId= and ?carId= filter
  .get("/api/tune-assignments",
    zValidator("query", CarIdQuerySchema),
    async (c) => {
      const { gameId, carId } = c.req.valid("query");
      return c.json(await getTuneAssignments({ gameId, carId }));
    }
  )

  // GET /api/tune-assignments/:carId/:trackId — get specific assignment
  .get("/api/tune-assignments/:carId/:trackId",
    zValidator("param", AssignmentParamsSchema),
    zValidator("query", AssignmentQuerySchema),
    async (c) => {
      const { carId, trackId } = c.req.valid("param");
      const { gameId } = c.req.valid("query");
      const assignment = await getTuneAssignment(gameId, carId, trackId);
      if (!assignment) return c.json({ error: "Assignment not found" }, 404);
      return c.json(assignment);
    }
  )

  // PUT /api/tune-assignments — set/update assignment
  .put("/api/tune-assignments",
    zValidator("json", SetAssignmentSchema),
    async (c) => {
      const { gameId, carId, trackId, tuneId } = c.req.valid("json");
      await setTuneAssignment(gameId, carId, trackId, tuneId);
      const assignment = await getTuneAssignment(gameId, carId, trackId);
      return c.json(assignment);
    }
  )

  // DELETE /api/tune-assignments/:carId/:trackId — remove assignment
  .delete("/api/tune-assignments/:carId/:trackId",
    zValidator("param", AssignmentParamsSchema),
    zValidator("query", AssignmentQuerySchema),
    async (c) => {
      const { carId, trackId } = c.req.valid("param");
      const { gameId } = c.req.valid("query");
      const deleted = await deleteTuneAssignment(gameId, carId, trackId);
      if (!deleted) return c.json({ error: "Assignment not found" }, 404);
      return c.json({ success: true });
    }
  )


  // ─── Lap tune override ──────────────────────────────────────────────────────

  // PATCH /api/laps/:id/tune — set or clear tune for specific lap
  .patch("/api/laps/:id/tune",
    zValidator("param", IdParamSchema),
    zValidator("json", LapTuneSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { tuneId } = c.req.valid("json");
      const updated = await updateLapTune(id, tuneId);
      if (!updated) return c.json({ error: "Lap not found" }, 404);
      return c.json({ success: true });
    }
  );

