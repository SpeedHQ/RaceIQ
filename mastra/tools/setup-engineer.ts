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
import { createTuningTest, deleteTestSubtree } from "../../server/db/tuning-test-queries";
import { setSessionHead } from "../../server/db/tuning-session-queries";
import { computeChildLabel, nextFreeLabel } from "../../server/ai/version-label";
import { saveAssistantChatMessage, tuneSessionThreadId } from "../../server/ai/chat-agent";
import { formatSymptoms } from "../../server/ai/tune-chat-prompt";
import {
  buildAppliedChangesMarkdown,
  computeSessionSymptoms,
  computeSessionTrackConditions,
  formatTrackConditions,
  loadActiveTuningContext,
} from "../../server/ai/setup-engineer-context";
import { readActiveSetup, writeAppliedSetup, activeSetupStem } from "../../server/ai/setup-io";
import { readSetupEngineerContext } from "./setup-engineer-request-context";
import { consultLapAnalystForSession } from "../../server/ai/consult-lap-analyst";
import { loadCleanLapAggregate } from "../../server/ai/clean-lap-aggregate";
import { setLapTuningExcluded } from "../../server/db/queries";
import { recordAction } from "../../server/db/tuning-action-queries";
import { undoLastAction } from "../../server/tuning-undo";

const DirectionEnum = z.enum(["increase", "decrease"]);
const MagnitudeEnum = z.enum(["small", "medium", "large"]);

// Per-session binding (gameId, sessionId) comes from Mastra requestContext, set
// once per turn by the chat route — NOT a model-supplied tool arg. Weak local
// models routinely dropped the sessionId arg, forcing a failed call + retry.
// Read tools therefore take NO input; every execute reads the context via
// readSetupEngineerContext(ctx.requestContext). Action tools keep only their
// change args (component/direction/magnitude), never sessionId.
const NoInput = z.object({});

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
    inputSchema: NoInput,
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
    execute: async (_input, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
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
    inputSchema: NoInput,
    outputSchema: z.object({
      available: z.boolean(),
      summary: z.string(),
    }),
    execute: async (_input, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
      const symptoms = await computeSessionSymptoms(sessionId);
      if (!symptoms) return { available: false, summary: "No analysable lap yet for this session." };
      return { available: true, summary: formatSymptoms(symptoms) };
    },
  });

  const getTrackConditionsTool = createTool({
    id: "get-track-conditions",
    description:
      "Get the deterministic weather / track-surface conditions (air & road temperature, rain, grip level, " +
      "wind, and for AC-EVO the static starting-grip label) measured across the session's representative lap — " +
      "the same fastest valid lap the symptom report uses. Returns 'available: false' when no lap has been " +
      "driven yet. Use this to reason about temperature-sensitive knobs (tyre pressures, which climb with hot " +
      "track/air) and grip: a green or wet track wants a softer, more compliant setup than an optimum dry one.",
    inputSchema: NoInput,
    outputSchema: z.object({
      available: z.boolean(),
      summary: z.string(),
      airTempC: z.object({ min: z.number(), max: z.number(), avg: z.number() }).nullable().optional(),
      roadTempC: z.object({ min: z.number(), max: z.number(), avg: z.number() }).nullable().optional(),
      rainIntensity: z.number().optional(),
      wet: z.boolean().optional(),
      trackGripStatus: z.string().optional(),
      windSpeedKmh: z.number().optional(),
      windDirectionDeg: z.number().optional(),
      startingGrip: z.string().nullable().optional(),
      staticWeather: z.boolean().nullable().optional(),
    }),
    execute: async (_input, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
      const tc = await computeSessionTrackConditions(sessionId);
      if (!tc) return { available: false, summary: "No analysable lap yet for this session." };
      return {
        available: true,
        summary: formatTrackConditions(tc),
        airTempC: tc.airTempC,
        roadTempC: tc.roadTempC,
        rainIntensity: tc.rainIntensity,
        wet: tc.wet,
        trackGripStatus: tc.trackGripStatus,
        windSpeedKmh: tc.windSpeedKmh,
        windDirectionDeg: tc.windDirectionDeg,
        startingGrip: tc.startingGrip,
        staticWeather: tc.staticWeather,
      };
    },
  });

  const consultLapAnalystTool = createTool({
    id: "consult-lap-analyst",
    description:
      "Delegate a full corner-by-corner driving/telemetry analysis of the session's representative lap to the " +
      "Lap Analyst — a separate expert agent. Use this when the driver asks something that needs telemetry " +
      "insight beyond the setup itself (e.g. where they're losing time, braking/throttle habits, which corners " +
      "cost the most), or to decide whether a slow lap is a driving issue rather than a setup one. Returns " +
      "'available: false' when no lap has been driven yet. This is a heavier call than get_symptoms — reach for " +
      "it when the setup signals aren't enough.",
    inputSchema: NoInput,
    outputSchema: z.object({
      available: z.boolean(),
      summary: z.string(),
    }),
    execute: async (_input, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
      return consultLapAnalystForSession(sessionId);
    },
  });

  const getVersionHistoryTool = createTool({
    id: "get-version-history",
    description:
      "Get every setup version tried in this session so far, oldest first: version number, label, engine " +
      "that produced it, and the changes applied to reach it from its parent. Use this to avoid repeating " +
      "a change that was already tried, or to reason about what's been attempted.",
    inputSchema: NoInput,
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
    execute: async (_input, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
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
    execute: async (inputData, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
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
    execute: async (inputData, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
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
      // ACC/AC-EVO: "<original filename stem>-<label>". F1 has no file, so the
      // label alone names the advisory diff.
      const stem = ctx.gameId === "f1-2025" ? label : `${activeSetupStem(ctx.gameId, ctx.realPath, "setup")}-${label}`;

      let written;
      try {
        written = writeAppliedSetup(ctx.gameId, { baseDir: ctx.baseDir, realPath: ctx.realPath, setup, stem });
      } catch (err: any) {
        return { ok: false, error: `Write failed: ${err.message}`, applied: [], skipped: [] };
      }

      const newTestId = await createTuningTest({
        tuningSessionId: sessionId,
        version: nextVer,
        label,
        setupPath: written.setupPath,
        setupSnapshot: written.setupSnapshot,
        parentTestId: parent?.id ?? null,
        appliedChanges: applied.length ? JSON.stringify(applied) : null,
        driverComment: null,
        engine: "llm",
      });

      // Branch grows and head follows the work: the new node becomes the head.
      const prevHeadTestId = parent?.id ?? null;
      try {
        await setSessionHead(sessionId, newTestId);
      } catch (err: any) {
        console.error("[SetupEngineer] Failed to advance head:", err?.message);
      }

      // Best-effort: an action-log write failure must not fail the apply —
      // the file + tuning test + head are already committed.
      try {
        await recordAction(sessionId, "apply-changes", { testId: newTestId, prevHeadTestId });
      } catch (err: any) {
        console.error("[SetupEngineer] Failed to log apply-changes action:", err?.message);
      }

      // Best-effort: a memory write failure must not fail the apply — the
      // file + tuning test are already committed.
      try {
        await saveAssistantChatMessage(
          tuneSessionThreadId(sessionId),
          buildAppliedChangesMarkdown(nextVer, applied, written.fileName, ctx.gameId !== "f1-2025"),
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
      "Accepts the version label (e.g. \"v1\", \"v1.2\") or the integer version number. " +
      "Set asNewRoot when the driver wants to use an old version as INSPIRATION for a fresh starting point " +
      "rather than a fork of it — the copy seeds a new root (no parent) instead of a child of the target, " +
      "so it grows its own line in the version tree.",
    inputSchema: z.object({
      target: z.string().describe("A version label like \"v1.2\" or an integer version like \"1\"."),
      asNewRoot: z.boolean().optional().describe(
        "When true, the copy becomes a new root (parentTestId=null) — an independent base inspired by the " +
        "target — instead of a child branch of it.",
      ),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      label: z.string().optional(),
      version: z.number().optional(),
    }),
    execute: async (inputData, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
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
      const guarded = await readActiveSetup(ctx.gameId, { setupPath: match.setupPath ?? null, setupSnapshot: match.setupSnapshot ?? null });
      if (!guarded.ok) {
        return { ok: false, error: `Could not read ${match.label}: ${guarded.error}` };
      }

      const nextVer = Math.max(0, ...ctx.tests.map((t) => t.version)) + 1;
      const asNewRoot = inputData.asNewRoot ?? false;

      // Branch-relative label off the forked target: existingChildCount = how
      // many children it already has (its continuation + any prior forks).
      // asNewRoot isn't a child of the target at all — it's an inspired fresh
      // start — so it gets its own "<label>-insp" line instead of continuing
      // the target's numbering.
      const takenLabels = new Set(ctx.tests.map((t) => t.label));
      const label = asNewRoot
        ? nextFreeLabel(`${match.label}-insp`, takenLabels)
        : nextFreeLabel(computeChildLabel(match.label, ctx.tests.filter((t) => t.parentTestId === match.id).length), takenLabels);
      const stem = ctx.gameId === "f1-2025" ? label : `${activeSetupStem(ctx.gameId, guarded.realPath, "setup")}-${label}`;

      let written;
      try {
        written = writeAppliedSetup(ctx.gameId, { baseDir: guarded.baseDir, realPath: guarded.realPath, setup: guarded.setup, stem });
      } catch (err: any) {
        return { ok: false, error: `Write failed: ${err.message}` };
      }

      const newTestId = await createTuningTest({
        tuningSessionId: sessionId,
        version: nextVer,
        label,
        setupPath: written.setupPath,
        setupSnapshot: written.setupSnapshot,
        parentTestId: asNewRoot ? null : match.id,
        appliedChanges: null,
        driverComment: null,
        engine: "branch",
      });

      // The fork (or new base) is the work surface now: head follows it.
      const prevHeadTestId = ctx.session.headTestId ?? null;
      try {
        await setSessionHead(sessionId, newTestId);
      } catch (err: any) {
        console.error("[SetupEngineer] Failed to advance head:", err?.message);
      }

      try {
        await recordAction(sessionId, "branch", { testId: newTestId, prevHeadTestId });
      } catch (err: any) {
        console.error("[SetupEngineer] Failed to log branch action:", err?.message);
      }

      try {
        await saveAssistantChatMessage(
          tuneSessionThreadId(sessionId),
          asNewRoot
            ? `Started a new base **${label}** (v${nextVer}) inspired by **${match.label}** — I'll work from here.`
            : `Branched **${label}** (v${nextVer}) from **${match.label}** — I'll work from here.`,
        );
      } catch (err: any) {
        console.error("[SetupEngineer] Failed to post branch note:", err?.message);
      }
      return { ok: true, label, version: nextVer };
    },
  });

  const setLapExcludedTool = createTool({
    id: "set-lap-excluded",
    description:
      "Include or exclude a specific lap from the session's clean-lap evidence pool (CONFIDENCE / LAP " +
      "BREAKDOWN / SYMPTOMS in the context block). Use when the driver agrees a named lap was a blunder " +
      "(off-track, spin, big outlier) that shouldn't count as clean — or to bring a previously-excluded lap " +
      "back in. Propose the exclusion by lap id first; only call this once the driver agrees.",
    inputSchema: z.object({
      lapId: z.number().int().positive(),
      excluded: z.boolean(),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      lapId: z.number().optional(),
      excluded: z.boolean().optional(),
    }),
    execute: async (inputData, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
      const { ok, prev } = await setLapTuningExcluded(inputData.lapId, inputData.excluded);
      if (!ok) return { ok: false, error: `No lap ${inputData.lapId} found.` };

      // Best-effort: an action-log write failure must not fail the tool — the
      // lap flag is already committed.
      try {
        await recordAction(sessionId, "set-lap-excluded", { lapId: inputData.lapId, prevExcluded: prev });
      } catch (err: any) {
        console.error("[SetupEngineer] Failed to log set-lap-excluded action:", err?.message);
      }

      return { ok: true, lapId: inputData.lapId, excluded: inputData.excluded };
    },
  });

  const compareLapConsistencyTool = createTool({
    id: "compare-lap-consistency",
    description:
      "Read-only. Get the per-corner racing-line and input consistency across the session's clean lap pool — " +
      "the same data summarised under CONSISTENCY BY CORNER in the context block, in full. Use for a deeper " +
      "on-demand look when deciding whether a slow or twitchy corner is a genuine setup issue or a driving " +
      "inconsistency (LOW TRUST corners point at the driver, not the car).",
    inputSchema: NoInput,
    outputSchema: z.object({
      available: z.boolean(),
      summary: z.string(),
      corners: z.array(z.object({
        corner: z.string(),
        lateralSpreadM: z.number(),
        brakeVar: z.number(),
        throttleVar: z.number(),
        lowTrust: z.boolean(),
      })).default([]),
    }),
    execute: async (_input, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
      const agg = await loadCleanLapAggregate(sessionId);
      const corners = agg.consistency.cornerConsistency;
      if (!corners) {
        return {
          available: false,
          summary: "Not enough clean laps (need ≥ 2) to measure line/input consistency.",
          corners: [],
        };
      }
      const lowTrust = corners.filter((c) => c.lowTrust).map((c) => c.corner);
      const summary = lowTrust.length
        ? `Low-trust (driving-inconsistent) corners: ${lowTrust.join(", ")}. Other corners show a trustworthy line/input signal.`
        : "All corners show a consistent line/inputs across the clean laps — deviations reflect the car, not the driver.";
      return { available: true, summary, corners };
    },
  });

  const deleteVersionTool = createTool({
    id: "delete-version",
    description:
      "Soft-delete a setup version and its whole branch (all versions forked from it). Reversible — trashed " +
      "versions can be restored later. If the session's current head is inside the deleted branch, the head " +
      "moves to the nearest surviving ancestor automatically. Confirm with the driver before calling — this " +
      "affects a real, laps-bearing version tree, not just the one node named.",
    inputSchema: z.object({
      testId: z.number().int().positive(),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      deletedIds: z.array(z.number()).default([]),
      headTestId: z.number().nullable().optional(),
    }),
    execute: async (inputData, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
      const ctx = await loadActiveTuningContext(sessionId);
      if (!ctx.ok) return { ok: false, error: ctx.error, deletedIds: [] };

      const test = ctx.tests.find((t) => t.id === inputData.testId);
      if (!test) return { ok: false, error: `No version ${inputData.testId} found in this session.`, deletedIds: [] };

      const result = await deleteTestSubtree(sessionId, inputData.testId, ctx.session.headTestId ?? null);

      try {
        await recordAction(sessionId, "delete", {
          rootTestId: inputData.testId,
          testIds: result.deletedIds,
          prevHeadTestId: result.headMoved ? result.prevHeadTestId : null,
        });
      } catch (err: any) {
        console.error("[SetupEngineer] Failed to log delete action:", err?.message);
      }

      return { ok: true, deletedIds: result.deletedIds, headTestId: result.newHeadTestId };
    },
  });

  const undoLastActionTool = createTool({
    id: "undo-last-action",
    description:
      "Undo the most recent action taken in this session (apply/branch/add-base/inspire/import/set-head/delete/" +
      "restore/rename/exclude) — user or AI. Use when the driver says \"undo that\" / \"undo the last change\" / " +
      "\"go back\". Reverses exactly one action per call; call again to go further back. If undoing a version " +
      "created by apply/branch/add-base/inspire and that version already has laps or child branches on it, it " +
      "warns and soft-deletes the whole subtree so nothing is silently stranded (restorable from the trash).",
    inputSchema: NoInput,
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      undone: z.boolean(),
      kind: z.string().optional(),
      warning: z.string().optional(),
    }),
    execute: async (_input, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
      const result = await undoLastAction(sessionId);

      if (result.undone) {
        try {
          await saveAssistantChatMessage(
            tuneSessionThreadId(sessionId),
            result.warning ? `Undone — ${result.warning}` : `Undone (${result.kind}).`,
          );
        } catch (err: any) {
          console.error("[SetupEngineer] Failed to post undo note:", err?.message);
        }
      }

      return result;
    },
  });

  return {
    getCurrentSetupTool,
    getSymptomsTool,
    getTrackConditionsTool,
    consultLapAnalystTool,
    getVersionHistoryTool,
    previewChangeTool,
    applyChangesTool,
    branchFromVersionTool,
    setLapExcludedTool,
    compareLapConsistencyTool,
    deleteVersionTool,
    undoLastActionTool,
  };
}

/**
 * Module-level singleton tool set — registered on the Mastra instance so Mastra
 * Studio lists them. Session binding is an explicit `sessionId` parameter on
 * every tool, supplied by the caller per call.
 */
export const setupEngineerTools = buildSetupEngineerTools();
