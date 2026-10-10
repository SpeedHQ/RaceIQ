import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { GameIdSchema } from "@raceiq/shared/games/ids";
import { getDashboard } from "@raceiq/backend-core/db/dashboard-queries";
import { getDashboardSessionRecap } from "@raceiq/backend-core/db/dashboard-recap-queries";
import { tryGetServerGame } from "@raceiq/backend-core/games/registry";
import { resolveCarName } from "@raceiq/game-catalogs/racing/cars/resolve-name";
import { resolveTrackName } from "@raceiq/game-catalogs/racing/tracks/resolve-name";
import { resolveLMUCar, resolveLMUTrack } from "@raceiq/game-lmu-metadata/catalog";

const instant = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/).refine((value) => Number.isFinite(Date.parse(value)), "Must be a finite UTC instant");
const DashboardQuery = z.object({
  from: instant,
  to: instant,
}).strict().superRefine((value, context) => {
  const from = Date.parse(value.from), to = Date.parse(value.to);
  if (from >= to) context.addIssue({ code: "custom", message: "from must precede to", path: ["from"] });
  if (to - from > 366 * 86_400_000) context.addIssue({ code: "custom", message: "Interval exceeds 366 days", path: ["to"] });
});
const GameHeader = z.object({ gameId: GameIdSchema.optional() });

const DashboardSessionParam = z.object({ id: z.string().regex(/^[1-9]\d*$/).transform(Number).refine(Number.isSafeInteger) });
export const dashboardRoutes = new Hono()
  .get("/api/dashboard", zValidator("query", DashboardQuery), async (c) => {
    const parsed = GameHeader.safeParse({ gameId: c.req.header("X-Game-Id") });
    if (!parsed.success) return c.json({ error: "Invalid X-Game-Id" }, 400);
    const query = c.req.valid("query");
    const dashboard = await getDashboard({ ...query, gameId: parsed.data.gameId });
    for (const session of dashboard.recentSessions) {
      const adapter = tryGetServerGame(session.gameId);
      for (const kind of ["track", "car"] as const) {
        const entity = session[kind];
        if (entity.name?.trim()) continue;
        const nativeId = typeof entity.id === "string" ? entity.id.trim() : entity.id;
        if (session.gameId === "lmu" && typeof nativeId === "string" && nativeId !== "" && !Number.isFinite(Number(nativeId))) {
          entity.name = (kind === "track" ? resolveLMUTrack(nativeId)?.name : resolveLMUCar(nativeId)?.name) ?? nativeId;
          continue;
        }
        const numericId = nativeId != null && nativeId !== "" ? Number(nativeId) : null;
        const ordinal = numericId != null && Number.isInteger(numericId) && numericId >= 0 ? numericId : entity.ordinal;
        if (ordinal == null || !Number.isInteger(ordinal) || ordinal < 0) continue;
        entity.name = kind === "track"
          ? adapter?.getTrackName(ordinal) ?? resolveTrackName(ordinal, session.gameId)
          : adapter?.getCarName(ordinal) ?? resolveCarName(ordinal, session.gameId);
      }
    }
    return c.json(dashboard);
  })
  .get("/api/dashboard/sessions/:id/recap", zValidator("param", DashboardSessionParam), async (c) => {
    const { id } = c.req.valid("param");
    const parsed = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
    if (!parsed.success) return c.json({ error: "Missing or invalid X-Game-Id" }, 400);
    const recap = await getDashboardSessionRecap(id, parsed.data);
    return recap ? c.json(recap) : c.json({ error: "Session not found" }, 404);
  });
