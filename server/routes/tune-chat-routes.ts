import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { IdParamSchema } from "../../shared/schemas";
import type { GameId } from "../../shared/types";
import { getLapById } from "../db/queries";
import { getExperiment } from "../db/experiment-queries";
import { detectCorners } from "../corner-detection";
import { telemetryToSymptoms } from "../ai/tune-symptoms";
import { symptomsToIssues } from "../ai/tune-issues";
import { setLiveIssuesEnabled } from "../pipeline";
import { loadSettings } from "../settings";
import {
  getChatMemory,
  tuneSessionThreadId,
  CHAT_RESOURCE_ID,
  resolveActiveThread,
  generationThreadId,
  listThreadGenerations,
} from "../ai/chat-agent";
import { buildGoogleReasoningProviderOptions } from "../ai/google-provider-options";
import { startDetachedAgentTurn } from "../ai/agent-stream";
import { reserveChatRun, buildReplayStream } from "../ai/chat-run-registry";
import { createUIMessageStreamResponse } from "ai";
import { createCodexChatResponse } from "../ai/codex-chat-stream";
import { getConfiguredAiProvider } from "../ai/provider-runtime";
import { sessionAgentForFocus } from "../ai/agents";
import { DEFAULT_EXPERIMENT_FOCUS, type ExperimentFocus } from "../../shared/experiment-focus";
import { buildSetupEngineerSystemPrompt } from "../../mastra/agents/setup-engineer";
import { RequestContext } from "@mastra/core/request-context";
import { setupEngineerTurnWorkflow } from "../../mastra/workflows/setup-engineer-turn";
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
// implementations via loadActiveExperimentContext, so /chat and the tools can't
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

  // GET /api/experiments?gameId= — list the driver's tuning sessions.
  .get("/api/experiments/:id/chat",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        const memory = getChatMemory();
        const base = tuneSessionThreadId(id);
        const genParam = Number(c.req.query("gen"));
        const threadId = Number.isInteger(genParam) && genParam >= 1
          ? generationThreadId(base, genParam)
          : await resolveActiveThread(base);
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

  // POST /api/experiments/:id/chat — send a message (streaming NDJSON).
  // Builds a fresh Setup Engineer Agent bound to this session's tools; the
  // agent decides for itself when to call get_setup / get_symptoms /
  // get_version_history / preview_change, and calls apply_changes once the
  // driver confirms (replacing the old separate generate-from-chat POST).
  .post("/api/experiments/:id/chat",
    zValidator("param", IdParamSchema),
    zValidator("json", TuneChatBodySchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { messages, extendedContext } = c.req.valid("json");

      // Resolved once, up front, before the early-persist block below creates
      // the base thread — resolving after it would materialize the base and
      // defeat the active-generation probe. Reused for early-persist,
      // reserveChatRun, memory, and the detached agent turn.
      const threadId = await resolveActiveThread(tuneSessionThreadId(id));

      const session = await getExperiment(id);
      if (!session) return c.json({ error: "Tuning session not found" }, 404);

      const gameId = session.gameId as GameId;
      if (gameId !== "acc" && gameId !== "ac-evo" && gameId !== "f1-2025") {
        return c.json({ error: "The setup engineer only supports ACC, AC-EVO and F1 2025" }, 400);
      }

      // Which specialist answers is decided by the experiment's focus column —
      // a switch, not a coordinator agent inferring a route the driver already
      // set with the workspace switcher. Both agents share this session's
      // thread, so flipping focus mid-conversation keeps the history continuous
      // (the switch happens *inside* the conversation).
      //
      // Authority is split by tool availability, not by prompt etiquette: only
      // the engineer has apply_changes, only the coach has record_drill.
      const focus = (session.focus as ExperimentFocus | null) ?? DEFAULT_EXPERIMENT_FOCUS;
      const agent = sessionAgentForFocus(focus);
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
          if (!(await mem.getThreadById({ threadId }))) {
            await mem.createThread({ threadId, resourceId: CHAT_RESOURCE_ID });
          }
          await mem.saveMessages({
            messages: [{
              id: lastUser.id ?? crypto.randomUUID(),
              role: "user",
              createdAt: new Date(),
              threadId,
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
        focus,
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
      let chatRuntime;
      try {
        chatRuntime = await getConfiguredAiProvider("chat", settings);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
      const chatProvider = chatRuntime.provider;

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

      if (chatProvider === "codex") {
        try {
          return await createCodexChatResponse({
            systemPrompt: systemSegments.join("\n\n"),
            messages,
            model: settings.chatModel,
          });
        } catch (err) {
          console.error("[SetupEngineer] Codex CLI failed:", err);
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
      }
      // Reserve (or re-attach to) this thread's detached run BEFORE calling
      // the agent — the double-start guard lives in the registry: if a turn
      // is already active for this thread (e.g. a duplicate POST fired while
      // one is in flight), `isNew` is false and we skip starting a second
      // agent call entirely, just attaching to the existing run's stream.
      const { run, isNew } = reserveChatRun(threadId);
      if (isNew) {
        const stream = await agent.stream(
          [{ role: "system", content: systemSegments.join("\n\n") }, ...messages],
          {
          memory: { thread: threadId, resource: CHAT_RESOURCE_ID },
          requestContext: reqCtx,
          // Threaded through so a client Cancel (POST .../run/cancel) or an
          // evicted/aborted run actually stops the underlying model call,
          // not just this HTTP response.
          abortSignal: run.abortController.signal,
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

        // Detaches immediately: the agent stream keeps running and gets
        // persisted server-side (onFinish inside agent-stream.ts) regardless
        // of whether the response below is ever read to completion.
        startDetachedAgentTurn(run, {
          agentStream: stream,
          originalMessages: messages,
          memory: getChatMemory(),
          threadId,
          turnStartedAt,
        });
      }

      // Same replay-then-live-tail stream the reconnect endpoint serves —
      // identical code path, so a fresh POST and a later reconnect are
      // indistinguishable to the client's transport.
      const response = createUIMessageStreamResponse({ stream: buildReplayStream(run) });
      response.headers.set("x-resumable-stream-id", run.runId);
      return response;
    }
  )

  // DELETE /api/experiments/:id/chat — clear the thread.
  .delete("/api/experiments/:id/chat",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        const memory = getChatMemory();
        const base = tuneSessionThreadId(id);
        const gens = await listThreadGenerations(base);
        const ids = new Set(gens.map((g) => g.threadId));
        ids.add(base);
        for (const threadId of ids) {
          await memory.deleteThread(threadId);
        }
      } catch (err: any) {
        console.error("[TuneChat] Failed to clear thread:", err.message);
      }
      return c.json({ ok: true });
    }
  )

  // GET /api/experiments/:id — one session.
  // Ships a computed `lapTarget` (Phase 5, track-length-aware stint nudge):
  // advisory-only "how many laps is a full stint here", derived from the
  // session's best known lap time, falling back to track length / avg speed,
  // falling back to a fixed default. Decoupled from the confidence model.
