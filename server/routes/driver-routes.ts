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
import { createHash } from "crypto";

import type { GameId } from "../../shared/types";
import { GameIdSchema } from "../../shared/types";
import { tryGetGame } from "../../shared/games/registry";
import { loadSettings } from "../settings";
import { getSecret } from "../keystore";
import { toClientAiError } from "../ai/provider-error";
import { driverProfilerAgent } from "../ai/agents";
import { buildDriverProfilerPrompt } from "../ai/driver-profiler-prompt";
import { getDriverProfileJsonSchema, parseDriverProfileOutput } from "../ai/schemas";
import { buildGoogleProviderOptions } from "../ai/google-provider-options";
import { loadDriverProfile, type DriverFingerprint } from "../ai/driver-profile-aggregate";
import {
  getLapMetaForProfileScope,
  getDriverProfile,
  saveDriverProfile,
  deleteDriverProfile,
} from "../db/queries";

const ScopeQuerySchema = z.object({
  carOrdinal: z.coerce.number().int().optional(),
  trackOrdinal: z.coerce.number().int().optional(),
  regenerate: z.coerce.boolean().optional().default(false),
  cacheOnly: z.coerce.boolean().optional().default(false),
});

type Scope = { gameId: GameId; carOrdinal?: number; trackOrdinal?: number };

/**
 * Digest of the lap ids currently in scope — the cache's staleness check.
 *
 * Driving one more lap changes the digest, so a stale plan stops being served
 * without anything having to decode telemetry to notice. A lap *count* would
 * miss the case where a lap is deleted in the same window another is added.
 */
function poolKeyFor(lapIds: number[]): string {
  return createHash("sha1").update(lapIds.slice().sort((a, b) => a - b).join(",")).digest("hex").slice(0, 16);
}

function resolveScopeNames(scope: Scope): { gameName: string; carName?: string; trackName?: string } {
  const game = tryGetGame(scope.gameId);
  if (!game) return { gameName: scope.gameId };
  return {
    gameName: game.displayName,
    carName: scope.carOrdinal != null ? game.getCarName(scope.carOrdinal) : undefined,
    trackName: scope.trackOrdinal != null ? game.getTrackName(scope.trackOrdinal) : undefined,
  };
}

/**
 * Drop focus areas whose `detectorId` is not in the fingerprint.
 *
 * The prompt forbids inventing faults, but a hallucinated id would render as a
 * confident coaching card for a problem the driver does not have — worse than
 * a shorter plan. Dropping is silent to the driver but reported in `warnings`.
 */
function pruneUnknownFocusAreas(
  plan: { focusAreas: { detectorId: string }[] },
  fingerprint: DriverFingerprint,
): { dropped: string[] } {
  const known = new Set(fingerprint.detectors.map((d) => d.id));
  const dropped: string[] = [];
  plan.focusAreas = plan.focusAreas.filter((f) => {
    if (known.has(f.detectorId)) return true;
    dropped.push(f.detectorId);
    return false;
  });
  return { dropped };
}

export const driverRoutes = new Hono()
  // ── Deterministic fingerprint only ──────────────────────────────────────
  .get("/api/drivers/profile", zValidator("query", ScopeQuerySchema), async (c) => {
    const gameId = c.req.header("x-game-id");
    const parsedGame = GameIdSchema.safeParse(gameId);
    if (!parsedGame.success) return c.json({ error: "Missing or unknown X-Game-Id header" }, 400);

    const { carOrdinal, trackOrdinal } = c.req.valid("query");
    const fingerprint = await loadDriverProfile({ gameId: parsedGame.data, carOrdinal, trackOrdinal });
    return c.json({ fingerprint, ...resolveScopeNames({ gameId: parsedGame.data, carOrdinal, trackOrdinal }) });
  })

  // ── Fingerprint + coached plan ──────────────────────────────────────────
  .post("/api/drivers/profile", zValidator("query", ScopeQuerySchema), async (c) => {
    const gameId = c.req.header("x-game-id");
    const parsedGame = GameIdSchema.safeParse(gameId);
    if (!parsedGame.success) return c.json({ error: "Missing or unknown X-Game-Id header" }, 400);

    const { carOrdinal, trackOrdinal, regenerate, cacheOnly } = c.req.valid("query");
    const scope: Scope = { gameId: parsedGame.data, carOrdinal, trackOrdinal };
    const names = resolveScopeNames(scope);

    // Cheap metadata-only scan first: it settles cache validity without
    // decoding a single telemetry frame, which is the expensive half.
    const candidates = await getLapMetaForProfileScope(scope.gameId, carOrdinal, trackOrdinal);
    const poolKey = poolKeyFor(candidates.map((l) => l.id));

    if (!regenerate) {
      const cached = await getDriverProfile(scope);
      if (cached && cached.poolKey === poolKey) {
        try {
          return c.json({
            plan: JSON.parse(cached.plan),
            fingerprint: JSON.parse(cached.fingerprint) as DriverFingerprint,
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
          // Corrupt cache row — fall through and regenerate rather than
          // replaying broken JSON forever.
        }
      }
      if (cacheOnly) return c.json({ plan: null, fingerprint: null, cached: false, ...names });
    }

    const fingerprint = await loadDriverProfile({ gameId: scope.gameId, carOrdinal, trackOrdinal });
    if (!fingerprint.ok) {
      return c.json({ error: "Not enough laps to build a profile", fingerprint, ...names }, 400);
    }

    const settings = loadSettings();
    const provider = settings.aiProvider;
    if (!provider) return c.json({ error: "No AI provider selected. Choose one in Settings → AI Analysis." }, 400);
    if (provider === "openai") {
      const key = await getSecret("openai-api-key");
      if (!key) return c.json({ error: "OpenAI API key not set. Add it in Settings → AI Analysis." }, 400);
      process.env.OPENAI_API_KEY = key;
    } else if (provider === "local") {
      process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "local";
      process.env.OPENAI_BASE_URL = settings.localEndpoint || "http://localhost:1234/v1";
    } else {
      const key = await getSecret("gemini-api-key");
      if (!key) return c.json({ error: "Gemini API key not set. Add it in Settings → AI Analysis." }, 400);
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
    }

    const prompt = buildDriverProfilerPrompt({
      fingerprint,
      gameName: names.gameName,
      carName: names.carName,
      trackName: names.trackName,
      language: settings.language,
    });

    const modelLabel =
      settings.aiModel ||
      (provider === "openai" ? "gpt-4o-mini" : provider === "local" ? "local-model" : "gemini-flash-latest");
    const startedAt = Date.now();
    const encoder = new TextEncoder();
    const writeEvent = (controller: ReadableStreamDefaultController, obj: unknown) => {
      try {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      } catch {
        /* closed */
      }
    };

    // Same heartbeat-NDJSON shape as POST /api/laps/:id/analyse: a `ping` every
    // ~200 s keeps Bun's 255 s idleTimeout alive for slow local models, then one
    // terminal `result` or `error`. Nothing intermediate is rendered.
    const readable = new ReadableStream({
      async start(controller) {
        const keepAlive = setInterval(() => writeEvent(controller, { type: "ping" }), 200_000);
        try {
          const result = await driverProfilerAgent.generate(prompt, {
            modelSettings: { maxOutputTokens: 6144, temperature: 0 },
            providerOptions: {
              openai: {
                responseFormat: {
                  type: "json_schema",
                  jsonSchema: {
                    name: "driver_profile_output",
                    strict: true,
                    schema: getDriverProfileJsonSchema() as Record<string, never>,
                  },
                } as never,
              },
              google: buildGoogleProviderOptions(
                modelLabel,
                getDriverProfileJsonSchema() as Record<string, unknown>,
                settings.aiThinkingBudget,
              ) as never,
            },
          });

          const parsed = parseDriverProfileOutput(typeof result.text === "string" ? result.text : "");
          if (!parsed.success) {
            console.warn(`[profile] model output failed schema validation — skipping cache write`);
            writeEvent(controller, {
              type: "error",
              message: "Model produced output that did not match the expected shape. Not cached. Try again or switch model.",
            });
            return;
          }

          const plan = parsed.data;
          const { dropped } = pruneUnknownFocusAreas(plan, fingerprint);
          if (dropped.length > 0) {
            console.warn(`[profile] dropped focus areas citing unknown detector ids: ${dropped.join(", ")}`);
          }

          const rawUsage = (result.usage ?? {}) as Record<string, unknown>;
          const n = (k: string) => (typeof rawUsage[k] === "number" ? (rawUsage[k] as number) : 0);
          const usage = {
            inputTokens: n("inputTokens") || n("promptTokens"),
            outputTokens: n("outputTokens") || n("completionTokens"),
            costUsd: 0,
            durationMs: Date.now() - startedAt,
            model: modelLabel,
          };

          await saveDriverProfile(scope, {
            poolKey,
            fingerprint: JSON.stringify(fingerprint),
            plan: JSON.stringify(plan),
            usage,
          });

          writeEvent(controller, {
            type: "result",
            plan,
            fingerprint,
            cached: false,
            usage,
            ...names,
            ...(dropped.length > 0 ? { warnings: [`Ignored ${dropped.length} focus area(s) citing faults not in the profile.`] } : {}),
          });
        } catch (err: unknown) {
          const aiError = toClientAiError(err);
          console.error("[AI] Driver profile failed:", aiError.message);
          writeEvent(controller, { type: "error", ...aiError });
        } finally {
          clearInterval(keepAlive);
          try {
            controller.close();
          } catch {
            /* already closed */
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

  // ── Drop the cached plan ────────────────────────────────────────────────
  .delete("/api/drivers/profile", zValidator("query", ScopeQuerySchema), async (c) => {
    const gameId = c.req.header("x-game-id");
    const parsedGame = GameIdSchema.safeParse(gameId);
    if (!parsedGame.success) return c.json({ error: "Missing or unknown X-Game-Id header" }, 400);

    const { carOrdinal, trackOrdinal } = c.req.valid("query");
    await deleteDriverProfile({ gameId: parsedGame.data, carOrdinal, trackOrdinal });
    return c.json({ ok: true });
  });
