import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { IdParamSchema } from "../../shared/schemas";
import type { GameId } from "../../shared/types";
import { getLapById } from "../db/queries";
import { getTuningSession } from "../db/tuning-session-queries";
import { detectCorners } from "../corner-detection";
import { telemetryToSymptoms } from "../ai/tune-symptoms";
import { symptomsToIssues } from "../ai/tune-issues";
import { setLiveIssuesEnabled } from "../pipeline";
import { loadSettings } from "../settings";
import { getChatMemory, tuneSessionThreadId, CHAT_RESOURCE_ID } from "../ai/chat-agent";
import { buildGoogleReasoningProviderOptions } from "../ai/google-provider-options";
import { streamAgentTurnResponse } from "../ai/agent-stream";
import { setupEngineerAgent } from "../ai/agents";
import { buildSetupEngineerSystemPrompt } from "../../mastra/agents/setup-engineer";
import { RequestContext } from "@mastra/core/request-context";
import { setupEngineerTurnWorkflow } from "../../mastra/workflows/setup-engineer-turn";
import { getSecret } from "../keystore";
import { MessageList } from "@mastra/core/agent";


const LiveAnalysisSchema = z.object({
  enabled: z.boolean(),
});


const TuneChatBodySchema = z.object({
  messages: z.array(z.any()),
  // Compact text summary of whatever lap review the driver currently has open
  // in the Review Laps dashboard (client's TuneReviewDashboard), rebuilt on
  // every lap switch and resent with every turn — lets the agent see exactly
  // what the driver is looking at without a tool round-trip. Capped well
  // above the builder's realistic output (a handful of sectors/corners/issues
  // renders to a few hundred bytes) as a defensive payload-size guard.
  extendedContext: z.string().max(8000).optional(),
});

// Setup-file guard, session-symptom, and applied-changes-markdown helpers
// (formerly local) now live in ../ai/setup-engineer-context — the Setup
// Engineer tools (mastra/tools/setup-engineer.ts) share the exact same
// implementations via loadActiveTuningContext, so /chat and the tools can't
// disagree about what "the active setup" is.


export const tuneChatRoutes = new Hono()
  .get("/api/laps/:id/issues",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const lap = await getLapById(id);
      if (!lap) return c.json({ error: "Lap not found" }, 404);

      const packets = lap.telemetry;
      if (packets.length < 30) return c.json([]);

      const corners = detectCorners(packets);
      const symptoms = telemetryToSymptoms(packets, corners);
      const issues = symptomsToIssues(symptoms, lap.lapNumber);
      return c.json(issues);
    }
  )

  // POST /api/live-analysis — toggle the pipeline's live transient issue
  // detector (Phase 4). Off by default: costs nothing extra per packet and
  // omits _liveIssues from the WS broadcast entirely.
  .post("/api/live-analysis",
    zValidator("json", LiveAnalysisSchema),
    async (c) => {
      const { enabled } = c.req.valid("json");
      setLiveIssuesEnabled(enabled);
      return c.json({ enabled });
    }
  )

  // ─── Tuning sessions (Setup Engineer front door, plan §6a) ─────────────────

  // GET /api/tuning-sessions?gameId= — list the driver's tuning sessions.
  .get("/api/tuning-sessions/:id/chat",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        const memory = getChatMemory();
        const threadId = tuneSessionThreadId(id);
        const thread = await memory.getThreadById({ threadId });
        if (!thread) return c.json({ messages: [] });
        const result = await memory.recall({ threadId });
        const raw = result.messages ?? [];

        const list = new MessageList({ threadId, resourceId: CHAT_RESOURCE_ID });
        list.add(raw, "memory");
        const uiMessages = list.get.all.aiV5
          .ui()
          .filter((m) => m.role === "user" || m.role === "assistant");

        return c.json({ messages: uiMessages });
      } catch (err: any) {
        console.error("[TuneChat] Failed to load messages:", err.message);
        return c.json({ messages: [] });
      }
    }
  )

  // POST /api/tuning-sessions/:id/chat — send a message (streaming NDJSON).
  // Builds a fresh Setup Engineer Agent bound to this session's tools; the
  // agent decides for itself when to call get_current_setup / get_symptoms /
  // get_version_history / preview_change, and calls apply_changes once the
  // driver confirms (replacing the old separate generate-from-chat POST).
  .post("/api/tuning-sessions/:id/chat",
    zValidator("param", IdParamSchema),
    zValidator("json", TuneChatBodySchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { messages, extendedContext } = c.req.valid("json");

      const session = await getTuningSession(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      const gameId = session.gameId as GameId;
      if (gameId !== "acc" && gameId !== "ac-evo" && gameId !== "f1-2025") {
        return c.json({ error: "The setup engineer only supports ACC, AC-EVO and F1 2025" }, 400);
      }

      // The Setup Engineer is now a shared singleton agent; per-session context
      // (car/track/sessionId the tools must receive) is injected per request as
      // a system message via buildSetupEngineerSystemPrompt.
      const agent = setupEngineerAgent;
      // Persist the incoming user message NOW, not at turn end. Mastra's
      // memory only writes the turn's messages when the stream finishes, so a
      // reload mid-turn made the just-sent user message vanish from history
      // until the assistant reply landed. Reuse the client's UIMessage id —
      // Mastra saveMessages upserts by id, so the trailing turn-end save
      // doesn't duplicate the row.
      try {
        const lastUser = [...messages].reverse().find((m: any) => m.role === "user") as any;
        const text = ((lastUser?.parts ?? []) as any[])
          .filter((p) => p?.type === "text")
          .map((p) => p.text ?? "")
          .join("");
        if (lastUser && text.trim()) {
          const mem = getChatMemory();
          const earlyThreadId = tuneSessionThreadId(id);
          if (!(await mem.getThreadById({ threadId: earlyThreadId }))) {
            await mem.createThread({ threadId: earlyThreadId, resourceId: CHAT_RESOURCE_ID });
          }
          await mem.saveMessages({
            messages: [{
              id: lastUser.id ?? crypto.randomUUID(),
              role: "user",
              createdAt: new Date(),
              threadId: earlyThreadId,
              resourceId: CHAT_RESOURCE_ID,
              type: "text",
              content: { format: 2, parts: [{ type: "text", text }], content: text },
            } as any],
          });
        }
      } catch (err: any) {
        console.error("[SetupEngineer] early user-message persist failed:", err?.message);
      }

      const sessionSystemPrompt = buildSetupEngineerSystemPrompt({
        gameId,
        sessionId: id,
        carName: session.carName,
        trackName: session.trackName,
        sessionName: session.name,
      });

      // Deterministic prerequisite gathering — force the read side (setup,
      // symptoms, track conditions, history) via the registered Mastra workflow
      // so the model always has current context and never has to call a read
      // tool or supply a session id. Studio-observable.
      const reqCtx = new RequestContext();
      reqCtx.set("gameId", gameId);
      reqCtx.set("sessionId", id);
      let gatheredContext = "";
      try {
        const prereqRun = await setupEngineerTurnWorkflow.createRun();
        const prereqResult = await prereqRun.start({ inputData: { sessionId: id }, requestContext: reqCtx });
        if (prereqResult.status === "success") gatheredContext = prereqResult.result.context;
      } catch (err: any) {
        console.error("[SetupEngineer] prereq workflow failed:", err?.message);
      }

      // Provider/key/model plumbing — inlined from startChatStream (see
      // ../ai/chat-stream.ts) since this route no longer uses the shared
      // NDJSON helper (assistant-ui speaks the AI SDK v5 UI-message-stream
      // protocol instead). Keep this block in sync with chat-stream.ts if
      // the provider matrix changes.
      const settings = loadSettings();
      const chatProvider = settings.chatProvider;
      if (chatProvider === "gemini") {
        const key = await getSecret("gemini-api-key");
        if (!key) return c.json({ error: "Gemini API key not set. Add it in Settings → AI Chat." }, 400);
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
        delete process.env.OPENAI_BASE_URL;
      } else if (chatProvider === "openai") {
        const key = await getSecret("openai-api-key");
        if (!key) return c.json({ error: "OpenAI API key not set. Add it in Settings → AI Chat." }, 400);
        process.env.OPENAI_API_KEY = key;
        delete process.env.OPENAI_BASE_URL;
      } else if (chatProvider === "local") {
        process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "local";
        process.env.OPENAI_BASE_URL = settings.localEndpoint || "http://localhost:1234/v1";
      }

      // Same model-label fallback chain chat-stream.ts uses, so thinking support
      // is detected off the model that will actually run.
      const chatModelLabel = settings.chatModel
        || (chatProvider === "openai"
          ? "gpt-4o-mini"
          : chatProvider === "local"
            ? "local-model"
            : "gemini-flash-latest");

      // Captured before the turn runs so the onFinish reasoning-patch below can
      // tell *this* turn's freshly-saved assistant row apart from any earlier
      // one (Mastra stamps createdAt at save time, so the new row's createdAt is
      // always >= this) — avoids racing/patching a previous turn's message.
      const turnStartedAt = Date.now();

      // System prompt segments, additive: session identity, deterministic
      // prereq-gathered context (setup/symptoms/history), then whatever lap
      // review the driver currently has open on screen (if any) — so the
      // agent's picture matches what the driver is looking at this turn.
      const systemSegments = [sessionSystemPrompt];
      if (gatheredContext) systemSegments.push(gatheredContext);
      if (extendedContext) systemSegments.push(extendedContext);

      const stream = await agent.stream(
        [{ role: "system", content: systemSegments.join("\n\n") }, ...messages],
        {
        memory: { thread: tuneSessionThreadId(id), resource: CHAT_RESOURCE_ID },
        requestContext: reqCtx,
        // Ask the model to stream its thought process so the tune chat can show a
        // live "thinking" block that auto-collapses once the reply text starts
        // (reasoning.tsx drives the collapse off the streamed reasoning parts).
        // toAISdkStream forwards reasoning parts into the UI-message stream by
        // default — the writer loop below relays every part — so enabling
        // reasoning here is the whole server-side wiring. Scoped to this route:
        // the main AiPanel keeps includeThoughts:false.
        providerOptions: {
          openai: { reasoningEffort: "medium" },
          google: buildGoogleReasoningProviderOptions(chatModelLabel, settings.chatThinkingBudget) as never,
        },
      });

      return streamAgentTurnResponse({
        agentStream: stream,
        originalMessages: messages,
        memory: getChatMemory(),
        threadId: tuneSessionThreadId(id),
        turnStartedAt,
      });
    }
  )

  // DELETE /api/tuning-sessions/:id/chat — clear the thread.
  .delete("/api/tuning-sessions/:id/chat",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        const memory = getChatMemory();
        await memory.deleteThread(tuneSessionThreadId(id));
      } catch (err: any) {
        console.error("[TuneChat] Failed to clear thread:", err.message);
      }
      return c.json({ ok: true });
    }
  )

  // GET /api/tuning-sessions/:id — one session.
  // Ships a computed `lapTarget` (Phase 5, track-length-aware stint nudge):
  // advisory-only "how many laps is a full stint here", derived from the
  // session's best known lap time, falling back to track length / avg speed,
  // falling back to a fixed default. Decoupled from the confidence model.
