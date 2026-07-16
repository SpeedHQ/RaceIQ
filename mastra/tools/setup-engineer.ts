/**
 * Setup Engineer tools (docs/setup-engineer-tools-plan.md §3, Phase 2).
 *
 * The applyable action space IS the tool schema — the model can only ever
 * name a component from `knownComponents(gameId)` (a zod enum baked in at
 * tool-construction time), and `preview_change` / `apply_changes` run the
 * SAME deterministic `applyIntents` the old rules-based autotune used, so the
 * number the agent states is always the real clamped result, never a guess.
 *
 * Session binding: `buildSetupEngineerTools({ gameId, sessionId })` is a
 * factory, not a module-level singleton. The chat route resolves the
 * session (and its gameId) once per request, then builds a fresh set of
 * tools closed over those two values plus a fresh `Agent` — see
 * `mastra/agents/setup-engineer.ts`. This sidesteps Mastra `runtimeContext`
 * entirely: no cross-call pending state, no thread-keyed scratch map.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import type { GameId } from "../../shared/types";
import type { TuneDirection, TuneMagnitude } from "../../server/ai/schemas";
import { applyIntents, describeKnobs, knownComponents } from "../../server/ai/tune-rules";
import { writeSetupFile } from "../../server/ai/tune-writer";
import { createTuningTest } from "../../server/db/tuning-test-queries";
import { setSessionHead } from "../../server/db/tuning-session-queries";
import { computeChildLabel, nextFreeLabel } from "../../server/ai/version-label";
import { saveAssistantChatMessage, tuneSessionThreadId } from "../../server/ai/chat-agent";
import { formatSymptoms } from "../../server/ai/tune-chat-prompt";
import {
  buildAppliedChangesMarkdown,
  computeSessionSymptoms,
  loadActiveTuningContext,
  setupPathStem,
} from "../../server/ai/setup-engineer-context";

const DirectionEnum = z.enum(["increase", "decrease"]);
const MagnitudeEnum = z.enum(["small", "medium", "large"]);

/** zod enum of the game's applyable knob names — the grounding mechanism. */
function componentEnum(gameId: GameId) {
  const names = knownComponents(gameId);
  return names.length > 0 ? z.enum(names as [string, ...string[]]) : z.enum(["none"] as [string, ...string[]]);
}

const AppliedChangeShape = z.object({
  component: z.string(),
  from: z.number(),
  to: z.number(),
  direction: DirectionEnum,
});

export interface SetupEngineerToolsContext {
  gameId: GameId;
  sessionId: number;
}

export function buildSetupEngineerTools({ gameId, sessionId }: SetupEngineerToolsContext) {
  const component = componentEnum(gameId);

  const getCurrentSetupTool = createTool({
    id: "get-current-setup",
    description:
      "Get the active setup version's tunable knobs: current value, min/max clamp range, and the " +
      "per-magnitude (small/medium/large) step size. This is the COMPLETE list of knobs you may ever " +
      "recommend or move — never suggest a change to anything not in this list.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      version: z.number().optional(),
      knobs: z.array(z.object({
        component: z.string(),
        current: z.number().nullable(),
        min: z.number(),
        max: z.number(),
        step: z.object({ small: z.number(), medium: z.number(), large: z.number() }),
      })).default([]),
    }),
    execute: async () => {
      const ctx = await loadActiveTuningContext(sessionId);
      if (!ctx.ok) return { ok: false, error: ctx.error, knobs: [] };
      return {
        ok: true,
        version: ctx.activeTest?.version ?? 0,
        knobs: describeKnobs(ctx.gameId, ctx.setup),
      };
    },
  });

  const getSymptomsTool = createTool({
    id: "get-symptoms",
    description:
      "Get the deterministic symptom report (balance per corner phase, lockups, bottoming) computed from " +
      "the session's fastest valid lap. Returns 'available: false' when no lap has been driven yet — " +
      "in that case, discuss the setup from the driver's description of how the car feels.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      available: z.boolean(),
      summary: z.string(),
    }),
    execute: async () => {
      const symptoms = await computeSessionSymptoms(sessionId);
      if (!symptoms) return { available: false, summary: "No analysable lap yet for this session." };
      return { available: true, summary: formatSymptoms(symptoms) };
    },
  });

  const getVersionHistoryTool = createTool({
    id: "get-version-history",
    description:
      "Get every setup version tried in this session so far, oldest first: version number, label, engine " +
      "that produced it, and the changes applied to reach it from its parent. Use this to avoid repeating " +
      "a change that was already tried, or to reason about what's been attempted.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      versions: z.array(z.object({
        version: z.number(),
        label: z.string(),
        engine: z.string().nullable(),
        driverComment: z.string().nullable(),
        changes: z.array(z.object({
          component: z.string(),
          from: z.number(),
          to: z.number(),
          direction: z.string(),
        })),
      })),
    }),
    execute: async () => {
      const ctx = await loadActiveTuningContext(sessionId);
      const tests = ctx.ok ? ctx.tests : [];
      return {
        versions: tests.map((t) => {
          let changes: { component: string; from: number; to: number; direction: string }[] = [];
          if (t.appliedChanges) {
            try {
              const parsed = JSON.parse(t.appliedChanges);
              if (Array.isArray(parsed)) changes = parsed;
            } catch { /* malformed history row — surface as no changes */ }
          }
          return {
            version: t.version,
            label: t.label,
            engine: t.engine,
            driverComment: t.driverComment,
            changes,
          };
        }),
      };
    },
  });

  const previewChangeTool = createTool({
    id: "preview-change",
    description:
      "Read-only. Run the deterministic rules engine for ONE candidate change against the active setup and " +
      "return the real resulting value (already clamped to the knob's range) WITHOUT saving anything. Use " +
      "this to state the actual effect of a suggestion before the driver confirms it, or to check whether a " +
      "knob is already at its limit (noop: true).",
    inputSchema: z.object({
      component,
      direction: DirectionEnum,
      magnitude: MagnitudeEnum,
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      noop: z.boolean().optional(),
      reason: z.string().optional(),
      from: z.number().optional(),
      to: z.number().optional(),
    }),
    execute: async (inputData) => {
      const ctx = await loadActiveTuningContext(sessionId);
      if (!ctx.ok) return { ok: false, error: ctx.error };
      const { setup, applied, skipped } = applyIntents(ctx.gameId, ctx.setup, [{
        component: inputData.component,
        direction: inputData.direction as TuneDirection,
        magnitude: inputData.magnitude as TuneMagnitude,
        reason: "preview",
      }]);
      void setup;
      if (applied.length > 0) {
        const c = applied[0]!;
        return { ok: true, noop: false, from: c.from, to: c.to };
      }
      return { ok: true, noop: true, reason: skipped[0]?.reason ?? "No effect" };
    },
  });

  const applyChangesTool = createTool({
    id: "apply-changes",
    description:
      "Commit the full set of changes the driver just confirmed. Applies every change via the deterministic " +
      "rules engine in one pass, writes a new versioned setup file, and records it as the session's next " +
      "tuning-test version. Call this ONCE, with the complete list of changes discussed — there is no " +
      "accumulator, so a change left out here will not be applied. Only call this after the driver has " +
      "explicitly confirmed they want it applied/generated.",
    inputSchema: z.object({
      changes: z.array(z.object({
        component,
        direction: DirectionEnum,
        magnitude: MagnitudeEnum,
        reason: z.string().describe("One short sentence: why this change, grounded in the symptoms/conversation."),
      })).min(1),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      version: z.number().optional(),
      fileName: z.string().optional(),
      applied: z.array(AppliedChangeShape).default([]),
      skipped: z.array(z.object({ component: z.string(), reason: z.string() })).default([]),
    }),
    execute: async (inputData) => {
      const ctx = await loadActiveTuningContext(sessionId);
      if (!ctx.ok) return { ok: false, error: ctx.error, applied: [], skipped: [] };

      const intents = inputData.changes.map((c) => ({
        component: c.component,
        direction: c.direction as TuneDirection,
        magnitude: c.magnitude as TuneMagnitude,
        reason: c.reason,
      }));
      const { setup, applied, skipped } = applyIntents(ctx.gameId, ctx.setup, intents);

      const parent = ctx.activeTest;
      const nextVer = Math.max(0, ...ctx.tests.map((t) => t.version)) + 1;

      // Branch-relative label off the head/parent. existingChildCount = how many
      // children the parent already has (its continuation + any forks).
      const parentLabel = parent?.label ?? "base";
      const childCount = parent ? ctx.tests.filter((t) => t.parentTestId === parent.id).length : 0;
      const takenLabels = new Set(ctx.tests.map((t) => t.label));
      const label = nextFreeLabel(computeChildLabel(parentLabel, childCount), takenLabels);
      const saveAsName = `${setupPathStem(ctx.realPath)}-${label}`;

      let written;
      try {
        written = writeSetupFile(ctx.baseDir, ctx.realPath, setup, saveAsName, false);
      } catch (err: any) {
        return { ok: false, error: `Write failed: ${err.message}`, applied: [], skipped: [] };
      }

      const newTestId = await createTuningTest({
        tuningSessionId: sessionId,
        version: nextVer,
        label,
        setupPath: written.path,
        parentTestId: parent?.id ?? null,
        appliedChanges: applied.length ? JSON.stringify(applied) : null,
        driverComment: null,
        engine: "llm",
      });

      // Branch grows and head follows the work: the new node becomes the head.
      try {
        await setSessionHead(sessionId, newTestId);
      } catch (err: any) {
        console.error("[SetupEngineer] Failed to advance head:", err?.message);
      }

      // Best-effort: a memory write failure must not fail the apply — the
      // file + tuning test are already committed.
      try {
        await saveAssistantChatMessage(
          tuneSessionThreadId(sessionId),
          buildAppliedChangesMarkdown(nextVer, applied, written.fileName),
        );
      } catch (err: any) {
        console.error("[SetupEngineer] Failed to post applied-tweaks message:", err?.message);
      }

      return {
        ok: true,
        version: nextVer,
        fileName: written.fileName,
        applied: applied.map((a) => ({ component: a.component, from: a.from, to: a.to, direction: a.direction })),
        skipped,
      };
    },
  });

  const branchFromVersionTool = createTool({
    id: "branch-from-version",
    description:
      "Check out an earlier version so the NEXT apply-changes branches from it instead of the latest. " +
      "Use when the driver asks to try a different direction from an older version without overwriting newer ones. " +
      "Accepts the version label (e.g. \"v1\", \"v1.2\") or the integer version number.",
    inputSchema: z.object({
      target: z.string().describe("A version label like \"v1.2\" or an integer version like \"1\"."),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      label: z.string().optional(),
    }),
    execute: async (inputData) => {
      const ctx = await loadActiveTuningContext(sessionId);
      if (!ctx.ok) return { ok: false, error: ctx.error };

      const target = inputData.target.trim();
      const asNum = Number(target.replace(/^v/i, ""));
      const match =
        ctx.tests.find((t) => t.label.toLowerCase() === target.toLowerCase()) ??
        (Number.isFinite(asNum) ? ctx.tests.find((t) => t.version === asNum) : undefined);

      if (!match) {
        return { ok: false, error: `No version matching "${target}" in this session.` };
      }

      await setSessionHead(sessionId, match.id);
      try {
        await saveAssistantChatMessage(
          tuneSessionThreadId(sessionId),
          `Switched to **${match.label}** as the current setup — I'll branch from here.`,
        );
      } catch (err: any) {
        console.error("[SetupEngineer] Failed to post branch note:", err?.message);
      }
      return { ok: true, label: match.label };
    },
  });

  return {
    getCurrentSetupTool,
    getSymptomsTool,
    getVersionHistoryTool,
    previewChangeTool,
    applyChangesTool,
    branchFromVersionTool,
  };
}
