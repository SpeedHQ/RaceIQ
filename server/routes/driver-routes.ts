/**
 * Driver profiling routes.
 *
 * `GET  /api/drivers/profile`  — the deterministic fingerprint, no model call.
 * `POST /api/drivers/profile`  — fingerprint + coached improvement plan (NDJSON).
 * `DELETE /api/drivers/profile` — drop the cached plan for a scope.
 *
 * Scope comes from the `X-Game-Id` header plus optional `carOrdinal` /
 * `trackOrdinal` query params. Supplying both ordinals gives a car+track
 * profile; supplying neither gives the driver's global profile for that game.
 * There is no driver id: this app is single-driver by design (issue #118), so
 * "the driver" is whoever owns the database.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { GameId } from "../../shared/types";
import { GameIdSchema } from "../../shared/types";
import {
  getDriverProfile,
  getLapMetaForProfileScope,
  deleteDriverProfile,
} from "../db/queries";
import { loadDriverProfile } from "../ai/driver-profile-aggregate";
import {
  driverProfilePoolKey,
  getDriverProfileRunStatus,
  resolveDriverProfileScopeNames,
  runDriverProfile,
  type DriverProfileScope,
} from "../ai/driver-profile-runner";

const ScopeQuerySchema = z.object({
  carOrdinal: z.coerce.number().int().optional(),
  trackOrdinal: z.coerce.number().int().optional(),
  regenerate: z.coerce.boolean().optional().default(false),
  cacheOnly: z.coerce.boolean().optional().default(false),
  runNow: z.coerce.boolean().optional().default(false),
  retry: z.coerce.boolean().optional().default(false),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

type Scope = DriverProfileScope;

export const driverRoutes = new Hono()
  // ── Deterministic fingerprint only ──────────────────────────────────────
  .get("/api/drivers/profile", zValidator("query", ScopeQuerySchema), async (c) => {
    const gameId = c.req.header("x-game-id");
    const parsedGame = GameIdSchema.safeParse(gameId);
    if (!parsedGame.success) return c.json({ error: "Missing or unknown X-Game-Id header" }, 400);

    const { carOrdinal, trackOrdinal } = c.req.valid("query");
    const fingerprint = await loadDriverProfile({ gameId: parsedGame.data, carOrdinal, trackOrdinal });
    return c.json({ fingerprint, ...resolveDriverProfileScopeNames({ gameId: parsedGame.data, carOrdinal, trackOrdinal }) });
  })

  // ── Fingerprint + coached plan ──────────────────────────────────────────
  .post("/api/drivers/profile", zValidator("query", ScopeQuerySchema), async (c) => {
    const gameId = c.req.header("x-game-id");
    const parsedGame = GameIdSchema.safeParse(gameId);
    if (!parsedGame.success) return c.json({ error: "Missing or unknown X-Game-Id header" }, 400);

    const { carOrdinal, trackOrdinal, regenerate, cacheOnly } = c.req.valid("query");
    const scope: Scope = { gameId: parsedGame.data, carOrdinal, trackOrdinal };
    const names = resolveDriverProfileScopeNames(scope);
    const candidates = await getLapMetaForProfileScope(scope.gameId, carOrdinal, trackOrdinal);
    const poolKey = driverProfilePoolKey(candidates.map((lap) => lap.id));
    const cached = await getDriverProfile(scope);

    if (!regenerate && cached && cached.poolKey === poolKey) {
      try {
        return c.json({
          plan: JSON.parse(cached.plan),
          fingerprint: JSON.parse(cached.fingerprint),
          cached: true,
          ...names,
          usage: {
            inputTokens: cached.inputTokens,
            outputTokens: cached.outputTokens,
            costUsd: cached.costUsd,
            durationMs: cached.durationMs,
            model: cached.model,
          },
        });
      } catch {
        // Corrupt cache rows are regenerated below.
      }
    }
    if (!regenerate && cacheOnly) return c.json({ plan: null, fingerprint: null, cached: false, ...names });

    const fingerprint = await loadDriverProfile({ gameId: scope.gameId, carOrdinal, trackOrdinal });
    if (!fingerprint.ok) return c.json({ error: "Not enough laps to build a profile", fingerprint, ...names }, 400);

    const readable = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const writeEvent = (event: unknown) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\\n"));
          } catch {
            // Client disconnected.
          }
        };
        const keepAlive = setInterval(() => writeEvent({ type: "ping" }), 200_000);
        try {
          const result = await runDriverProfile(scope, { force: true, trigger: "manual" });
          if (result.status === "succeeded") {
            writeEvent({
              type: "result",
              plan: result.plan,
              fingerprint: result.fingerprint,
              cached: false,
              usage: result.usage,
              ...names,
              ...(result.warnings ? { warnings: result.warnings } : {}),
            });
          } else {
            writeEvent({ type: "error", message: result.error ?? `Driver profile run ${result.status}.`, state: result.status });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeEvent({ type: "error", message });
        } finally {
          clearInterval(keepAlive);
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        }
      },
    });
    return new Response(readable, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        "Transfer-Encoding": "chunked",
      },
    });
  })

  // ── Tracked status/history and explicit run-now/retry ────────────────────
  .get("/api/drivers/profile/runs", zValidator("query", ScopeQuerySchema), async (c) => {
    const gameId = c.req.header("x-game-id");
    const parsedGame = GameIdSchema.safeParse(gameId);
    if (!parsedGame.success) return c.json({ error: "Missing or unknown X-Game-Id header" }, 400);
    const { carOrdinal, trackOrdinal, limit } = c.req.valid("query");
    const scope: Scope = { gameId: parsedGame.data, carOrdinal, trackOrdinal };
    return c.json({ scope, ...resolveDriverProfileScopeNames(scope), ...(await getDriverProfileRunStatus(scope, limit)) });
  })
  .post("/api/drivers/profile/runs", zValidator("query", ScopeQuerySchema), async (c) => {
    const gameId = c.req.header("x-game-id");
    const parsedGame = GameIdSchema.safeParse(gameId);
    if (!parsedGame.success) return c.json({ error: "Missing or unknown X-Game-Id header" }, 400);
    const { carOrdinal, trackOrdinal, runNow, retry } = c.req.valid("query");
    const scope: Scope = { gameId: parsedGame.data, carOrdinal, trackOrdinal };
    if (!runNow && !retry) {
      return c.json({ error: "Specify runNow=true or retry=true.", state: "not-configured" }, 400);
    }
    const result = await runDriverProfile(scope, { force: true, trigger: retry ? "retry" : "manual" });
    return c.json({
      scope,
      ...resolveDriverProfileScopeNames(scope),
      state: result.status,
      run: result.run,
      ...(result.plan ? { plan: result.plan } : {}),
      ...(result.fingerprint ? { fingerprint: result.fingerprint } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.warnings ? { warnings: result.warnings } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  })

  // ── Drop the cached plan ────────────────────────────────────────────────
  .delete("/api/drivers/profile", zValidator("query", ScopeQuerySchema), async (c) => {
    const gameId = c.req.header("x-game-id");
    const parsedGame = GameIdSchema.safeParse(gameId);
    if (!parsedGame.success) return c.json({ error: "Missing or unknown X-Game-Id header" }, 400);

    const { carOrdinal, trackOrdinal } = c.req.valid("query");
    await deleteDriverProfile({ gameId: parsedGame.data, carOrdinal, trackOrdinal });
    return c.json({ ok: true });
  });
