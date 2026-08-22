import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { GameIdSchema } from "../../shared/games/ids";
import { z } from "zod";
import { getLapMetaById } from "../db/lap-read-queries";
import { getExperiment } from "../db/experiment-queries";
import { resolveCarName } from "../../shared/racing/cars/resolve-name";
import { resolveTrackName } from "../../shared/racing/tracks/resolve-name";
import {
  getChatMemory,
  CHAT_RESOURCE_ID,
  parseThreadGeneration,
  isCanonicalThreadId,
  parseCompareChatThreadId,
  listThreadGenerations,
  truncateChatAfterUserMessage,
  deleteChatLineage,
} from "../ai/chat-agent";
import { forkThreadWithSummary, InvalidThreadGenerationError, NothingToCompactError } from "../ai/compact-thread";

const ChatsQuerySchema = z.object({
  gameId: GameIdSchema,
});
const RegenerateBodySchema = z.object({
  messageId: z.string().min(1),
});

interface LapSummary {
  id: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  carName: string;
  trackName: string;
  gameId: string;
}

/** Setup-engineer (experiment) chat, keyed by session rather than laps. */
interface TuneSummary {
  id: number;
  seq: number;
  name: string;
  carName: string;
  gameId: string;
}

interface ChatRow {
  threadId: string;
  type: "analyse" | "compare" | "tune";
  laps: LapSummary[];
  /** Present for type === "tune". */
  tune?: TuneSummary;
  trackName: string;
  createdAt: string;
  updatedAt: string;
}

async function loadLapSummary(id: number): Promise<LapSummary | null> {
  const lap = await getLapMetaById(id);
  if (!lap) return null;
  return {
    id,
    lapNumber: lap.lapNumber,
    lapTime: lap.lapTime,
    isValid: lap.isValid,
    carName: resolveCarName(lap.carOrdinal ?? 0, lap.gameId),
    trackName: resolveTrackName(lap.trackOrdinal ?? 0, lap.gameId),
    gameId: lap.gameId ?? "",
  };
}

export function createChatsRoutes(compactThread: typeof forkThreadWithSummary = forkThreadWithSummary) {
  return (
    new Hono()
      // ── List chat sessions for a game ─────────────────────────
      .get("/api/chats", zValidator("query", ChatsQuerySchema), async (c) => {
        const { gameId } = c.req.valid("query");
        try {
          const memory = getChatMemory();
          const result = await memory.listThreads({
            filter: { resourceId: CHAT_RESOURCE_ID },
            perPage: false,
          });
          const rows: ChatRow[] = [];
          for (const t of result.threads) {
            const id = parseThreadGeneration(t.id).base;
            if (id.startsWith("lap-")) {
              const lapId = Number(id.slice(4));
              if (!Number.isFinite(lapId)) continue;
              const lap = await loadLapSummary(lapId);
              if (!lap || lap.gameId !== gameId) continue;
              rows.push({
                threadId: id,
                type: "analyse",
                laps: [lap],
                trackName: lap.trackName,
                createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : String(t.createdAt),
                updatedAt: t.updatedAt instanceof Date ? t.updatedAt.toISOString() : String(t.updatedAt),
              });
            } else if (id.startsWith("compare-")) {
              const pair = parseCompareChatThreadId(id);
              if (!pair) continue;
              const [a, b] = pair;
              const [lapA, lapB] = await Promise.all([loadLapSummary(a), loadLapSummary(b)]);
              if (!lapA || !lapB) continue;
              if (lapA.gameId !== gameId || lapB.gameId !== gameId) continue;
              rows.push({
                threadId: id,
                type: "compare",
                laps: [lapA, lapB],
                trackName: lapA.trackName,
                createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : String(t.createdAt),
                updatedAt: t.updatedAt instanceof Date ? t.updatedAt.toISOString() : String(t.updatedAt),
              });
            } else if (id.startsWith("tune-session-")) {
              const sessionId = Number(id.slice("tune-session-".length));
              if (!Number.isFinite(sessionId)) continue;
              const session = await getExperiment(sessionId);
              if (!session || session.gameId !== gameId) continue;
              const carName = session.carName ?? resolveCarName(session.carOrdinal ?? 0, session.gameId);
              const trackName = session.trackName ?? resolveTrackName(session.trackOrdinal ?? 0, session.gameId);
              rows.push({
                threadId: id,
                type: "tune",
                laps: [],
                tune: { id: session.id, seq: session.seq, name: session.name, carName, gameId: session.gameId },
                trackName,
                createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : String(t.createdAt),
                updatedAt: t.updatedAt instanceof Date ? t.updatedAt.toISOString() : String(t.updatedAt),
              });
            }
          }
          // Multiple generations of the same lineage share a base thread id
          // after stripping `~gN` above; collapse them to a single row, keeping
          // whichever generation was updated most recently.
          const byBase = new Map<string, ChatRow>();
          for (const row of rows) {
            const existing = byBase.get(row.threadId);
            if (!existing || row.updatedAt > existing.updatedAt) {
              byBase.set(row.threadId, row);
            }
          }
          const deduped = [...byBase.values()];
          deduped.sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
          return c.json({ chats: deduped });
        } catch (err: any) {
          console.error("[Chats] Failed to list:", err.message);
          return c.json({ chats: [], error: err.message }, 500);
        }
      })

      // ── Delete a chat session (all generations) ────────────────
      .delete("/api/chats/:threadId", async (c) => {
        const threadId = c.req.param("threadId");
        try {
          const { base } = parseThreadGeneration(threadId);
          await deleteChatLineage(base);
          return c.json({ ok: true });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[Chats] Failed to delete:", message);
          return c.json({ error: message }, 500);
        }
      })

      // ── List the generations for a chat lineage ────────────────
      .get("/api/chats/:threadId/generations", async (c) => {
        const threadId = c.req.param("threadId");
        const { base } = parseThreadGeneration(threadId);
        try {
          const gens = await listThreadGenerations(base);
          if (gens.length === 0) {
            return c.json({
              activeThreadId: base,
              generations: [{ threadId: base, generation: 1, active: true }],
            });
          }
          const maxGen = gens[gens.length - 1].generation;
          return c.json({
            activeThreadId: gens[gens.length - 1].threadId,
            generations: gens.map((g) => ({ ...g, active: g.generation === maxGen })),
          });
        } catch (err: any) {
          console.error("[Chats] Failed to list generations:", err.message);
          return c.json({ error: err.message }, 500);
        }
      })

      // ── Fork a chat thread (summarize + start new generation) ──
      .post("/api/chats/:threadId/compact", async (c) => {
        const threadId = c.req.param("threadId");
        if (!isCanonicalThreadId(threadId)) {
          return c.json({ error: "Invalid chat thread generation" }, 400);
        }
        try {
          const result = await compactThread(threadId);
          return c.json(result);
        } catch (err: unknown) {
          if (err instanceof InvalidThreadGenerationError) {
            return c.json({ error: err.message }, 400);
          }
          if (err instanceof NothingToCompactError) {
            return c.json({ error: err.message }, 422);
          }
          const message = err instanceof Error ? err.message : String(err);
          console.error("[Chats] Failed to compact:", message);
          return c.json({ error: message }, 500);
        }
      })
      // ── Regenerate from a persisted user prompt ─────────────────
      .post("/api/chats/:threadId/regenerate", zValidator("json", RegenerateBodySchema), async (c) => {
        const threadId = c.req.param("threadId");
        const { messageId } = c.req.valid("json");
        try {
          const result = await truncateChatAfterUserMessage(threadId, messageId);
          return c.json({ ok: true, prompt: result.prompt });
        } catch (err: any) {
          if (err?.message === "User message not found") {
            return c.json({ error: err.message }, 404);
          }
          console.error("[Chats] Failed to regenerate:", err?.message);
          return c.json({ error: err?.message ?? "Could not regenerate chat" }, 500);
        }
      })
  );
}

export const chatsRoutes = createChatsRoutes();
