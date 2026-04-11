import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { GameIdSchema } from "../../shared/types";
import { z } from "zod";
import { getLapById } from "../db/queries";
import { getCarName, getTrackName } from "../../shared/car-data";
import { getChatMemory, CHAT_RESOURCE_ID } from "../ai/chat-agent";

const ChatsQuerySchema = z.object({
  gameId: GameIdSchema,
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

interface ChatRow {
  threadId: string;
  type: "analyse" | "compare";
  laps: LapSummary[];
  trackName: string;
  createdAt: string;
  updatedAt: string;
}

async function loadLapSummary(id: number): Promise<LapSummary | null> {
  const lap = await getLapById(id);
  if (!lap) return null;
  return {
    id,
    lapNumber: lap.lapNumber,
    lapTime: lap.lapTime,
    isValid: lap.isValid,
    carName: getCarName(lap.carOrdinal ?? 0, lap.gameId),
    trackName: getTrackName(lap.trackOrdinal ?? 0, lap.gameId),
    gameId: lap.gameId ?? "",
  };
}

export const chatsRoutes = new Hono()
  // ── List chat sessions for a game ─────────────────────────
  .get(
    "/api/chats",
    zValidator("query", ChatsQuerySchema),
    async (c) => {
      const { gameId } = c.req.valid("query");
      try {
        const memory = getChatMemory();
        const result = await memory.listThreads({
          filter: { resourceId: CHAT_RESOURCE_ID },
          perPage: false,
        });
        const rows: ChatRow[] = [];
        for (const t of result.threads) {
          const id = t.id;
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
            const parts = id.slice(8).split("-");
            if (parts.length !== 2) continue;
            const a = Number(parts[0]);
            const b = Number(parts[1]);
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
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
          }
        }
        rows.sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
        return c.json({ chats: rows });
      } catch (err: any) {
        console.error("[Chats] Failed to list:", err.message);
        return c.json({ chats: [], error: err.message }, 500);
      }
    }
  )

  // ── Delete a chat session ──────────────────────────────────
  .delete(
    "/api/chats/:threadId",
    async (c) => {
      const threadId = c.req.param("threadId");
      try {
        const memory = getChatMemory();
        await memory.deleteThread(threadId);
        return c.json({ ok: true });
      } catch (err: any) {
        console.error("[Chats] Failed to delete:", err.message);
        return c.json({ error: err.message }, 500);
      }
    }
  );
