import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { IdParamSchema } from "../../../shared/schemas";
import { getExperiment } from "../../db/experiment-queries";
import { listActions } from "../../db/experiment-action-queries";
import { undoLastAction } from "../../experiments/undo";
import { tuneSessionThreadId, saveChatMessages } from "../../ai/chat-agent";

export const experimentHistoryRoutes = new Hono()
  // GET /api/experiments/:id/actions — session action log, newest-first
  // (design Phase 9), for the History panel. Tiny rows (refs only), so the
  // whole session depth is returned unpaginated.
  .get("/api/experiments/:id/actions",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getExperiment(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);
      return c.json(await listActions(id));
    }
  )

  // POST /api/experiments/:id/undo — reverse the newest not-yet-undone
  // action (design Phase 9). Applies the kind-specific inverse via
  // `undoLastAction` (shared with the AI's `undo_last_action` tool),
  // idempotent — a second call with nothing left pending is a no-op ok:true.
  .post("/api/experiments/:id/undo",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const session = await getExperiment(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      const result = await undoLastAction(id);

      if (result.undone) {
        try {
          await saveChatMessages(tuneSessionThreadId(id), [
            { role: "user", markdown: "Undo the last action." },
            {
              role: "assistant",
              markdown: result.warning ? `Undone — ${result.warning}` : `Undone (${result.kind}).`,
            },
          ]);
        } catch (err: any) {
          console.error("[tune] Failed to post undo note:", err?.message);
        }
      }

      return c.json(result);
    }
  );
