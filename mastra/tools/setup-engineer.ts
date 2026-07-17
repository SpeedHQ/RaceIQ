/**
 * Setup Engineer tools (docs/setup-engineer-tools-plan.md §3, Phase 2).
 *
 * `preview_change` / `apply_changes` run the SAME deterministic `applyIntents`
 * the old rules-based autotune used, so the number the agent states is always
 * the real clamped result, never a guess. Unknown component names are skipped
 * with a reason (see `applyIntents`) rather than rejected at the schema, since
 * static tools cannot bake a per-game `knownComponents` enum into the schema.
 *
 * Session binding: the tools are module-level singletons (registered on the
 * Mastra instance, so Mastra Studio lists them). They hold no state and close
 * over nothing. Every tool takes an explicit `sessionId` parameter — the caller
 * (chat route) passes the resolved session id on each call, and `gameId` is
 * derived from it via `loadActiveTuningContext(sessionId)`. Pure functions of
 * their inputs: unit-testable, no requestContext coupling, no cross-call state.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import type { TuneDirection, TuneMagnitude } from "../../server/ai/schemas";
import { applyIntents, describeKnobs } from "../../server/ai/tune-rules";
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
  resolveGuardedSetupFile,
  setupPathStem,
} from "../../server/ai/setup-engineer-context";

const DirectionEnum = z.enum(["increase", "decrease"]);
const MagnitudeEnum = z.enum(["small", "medium", "large"]);

// Session binding is an explicit tool parameter (not requestContext), so these
// stay plain static tools: the chat route passes the resolved sessionId on every
// call. gameId is derived from the session via loadActiveTuningContext(sessionId).
const SessionIdField = z
  .number()
  .int()
  .positive()
  .describe("The tuning session id to operate on (resolved by the caller).");
const SessionOnly = z.object({ sessionId: SessionIdField });

const AppliedChangeShape = z.object({
  component: z.string(),
  from: z.number(),
  to: z.number(),
  direction: DirectionEnum,
});

export function buildSetupEngineerTools() {

  const getCurrentSetupTool = createTool({
    id: "get-current-setup",
    description:
      "Get the active setup version's tunable knobs: current value, min/max clamp range, and the " +
      "per-magnitude (small/medium/large) step size. This is the COMPLETE list of knobs you may ever " +
      "recommend or move — never suggest a change to anything not in this list.",
    inputSchema: SessionOnly,
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
    execute: async ({ sessionId }) => {
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
    inputSchema: SessionOnly,
    outputSchema: z.object({
      available: z.boolean(),
      summary: z.string(),
    }),
    execute: async ({ sessionId }) => {
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
    inputSchema: SessionOnly,
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
    execute: async ({ sessionId }) => {
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
      sessionId: SessionIdField,
      component: z.string(),
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
      const { sessionId } = inputData;
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
      sessionId: SessionIdField,
      changes: z.array(z.object({
        component: z.string(),
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
      const { sessionId } = inputData;
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
      "Fork an earlier version into a new branch immediately. Creates a real new version whose setup is an " +
      "exact copy of the target, makes it the session head, and returns it — so it shows up in the version " +
      "tree right away and the NEXT apply-changes lands on this fork instead of the latest. " +
      "Use when the driver asks to try a different direction from an older version without overwriting newer ones. " +
      "Accepts the version label (e.g. \"v1\", \"v1.2\") or the integer version number.",
    inputSchema: z.object({
      sessionId: SessionIdField,
      target: z.string().describe("A version label like \"v1.2\" or an integer version like \"1\"."),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      label: z.string().optional(),
      version: z.number().optional(),
    }),
    execute: async (inputData) => {
      const { sessionId } = inputData;
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

      // Load the target's setup exactly as saved — the fork is a byte-for-byte
      // copy under a new version, so the branch point is visible in the tree
      // before any changes are applied.
      const guarded = await resolveGuardedSetupFile(ctx.gameId, match.setupPath ?? "");
      if (!guarded.ok) {
        return { ok: false, error: `Could not read ${match.label}: ${guarded.error}` };
      }

      const nextVer = Math.max(0, ...ctx.tests.map((t) => t.version)) + 1;

      // Branch-relative label off the forked target: existingChildCount = how
      // many children it already has (its continuation + any prior forks).
      const childCount = ctx.tests.filter((t) => t.parentTestId === match.id).length;
      const takenLabels = new Set(ctx.tests.map((t) => t.label));
      const label = nextFreeLabel(computeChildLabel(match.label, childCount), takenLabels);
      const saveAsName = `${setupPathStem(guarded.realPath)}-${label}`;

      let written;
      try {
        written = writeSetupFile(guarded.baseDir, guarded.realPath, guarded.setup, saveAsName, false);
      } catch (err: any) {
        return { ok: false, error: `Write failed: ${err.message}` };
      }

      const newTestId = await createTuningTest({
        tuningSessionId: sessionId,
        version: nextVer,
        label,
        setupPath: written.path,
        parentTestId: match.id,
        appliedChanges: null,
        driverComment: null,
        engine: "branch",
      });

      // The fork is the work surface now: head follows it.
      try {
        await setSessionHead(sessionId, newTestId);
      } catch (err: any) {
        console.error("[SetupEngineer] Failed to advance head:", err?.message);
      }

      try {
        await saveAssistantChatMessage(
          tuneSessionThreadId(sessionId),
          `Branched **${label}** (v${nextVer}) from **${match.label}** — I'll work from here.`,
        );
      } catch (err: any) {
        console.error("[SetupEngineer] Failed to post branch note:", err?.message);
      }
      return { ok: true, label, version: nextVer };
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

/**
 * Module-level singleton tool set — registered on the Mastra instance so Mastra
 * Studio lists them. Session binding is an explicit `sessionId` parameter on
 * every tool, supplied by the caller per call.
 */
export const setupEngineerTools = buildSetupEngineerTools();
