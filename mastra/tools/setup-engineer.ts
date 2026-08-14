/**
 * Setup Engineer tools (docs/architecture/setup-engineer.md).
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
 * derived from it via `loadActiveExperimentContext(sessionId)`. Pure functions of
 * their inputs: unit-testable, no requestContext coupling, no cross-call state.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { CHAT_TURN_MESSAGES_KEY, hasExplicitChangeConfirmation } from "../../server/ai/chat-message-context";

import type { TuneDirection, TuneMagnitude } from "../../server/ai/schemas";
import { applyIntents, describeKnobs } from "../../server/setups/rules/engine";
import {
  createExperimentVersion,
  deleteTestSubtree,
  getExperimentVersion,
  getExperimentVersionsByLabel,
  nextVersion,
  resolveActiveTestId,
  setExperimentVersionNote,
  setExperimentVersionNotes,
} from "../../server/db/experiment-version-queries";
import { setSessionHead } from "../../server/db/experiment-queries";
import { changeSlug, computeChildLabel, nextFreeLabel } from "../../server/ai/version-label";
import { saveAssistantChatMessage, tuneSessionThreadId } from "../../server/ai/chat-agent";
import { wsManager } from "../../server/runtime/websocket-manager";
import { formatSymptoms } from "../../server/ai/tune-chat-prompt";
import { buildAppliedChangesMarkdown } from "../../server/setups/applied-change-markdown";
import { formatTrackConditions } from "../../server/ai/track-conditions";
import { gameHasSetupFile, loadActiveExperimentContext } from "../../server/experiments/setup-lineage";
import { readActiveSetup, writeAppliedSetup } from "../../server/setups/io";
import { readSetupEngineerContext } from "./setup-engineer-request-context";
import { consultLapAnalystForSession } from "../../server/ai/consult-lap-analyst";
import { loadCleanLapAggregate } from "../../server/experiments/lap-evidence/aggregate";
import { selectEvaluationLaps } from "../../shared/racing/laps/review-selection";
import { eligibilityDecisionText } from "../../shared/racing/quality/display";
import { setLapExperimentExcluded, getLapsForExperiment } from "../../server/db/experiment-lap-queries";
import { getLapById } from "../../server/db/lap-read-queries";
import { resolveTrack } from "../../server/tracks/info";
import { recordAction } from "../../server/db/experiment-action-queries";
import { undoLastAction } from "../../server/experiments/undo";
import { detectCorners } from "../../server/lap-analysis/corners";
import { telemetryToSymptoms } from "../../server/ai/tune-symptoms";
import { symptomsToIssues } from "../../server/ai/tune-issues";
import { compareLaps } from "../../server/lap-analysis/comparison";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { LapMeta } from "../../shared/racing/sessions/types";

const DirectionEnum = z.enum(["increase", "decrease"]);
const MagnitudeEnum = z.enum(["small", "medium", "large"]);
const EligibilityStatusEnum = z.enum(["eligible", "eligible_with_warning", "ineligible", "unknown"]);

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

const IssueShape = z.object({
  kind: z.string(),
  severity: z.string(),
  corner: z.string().optional(),
  detail: z.string(),
  lapNumber: z.number().optional(),
});

const CornerSnapShape = z.object({
  tempC: z.number(),
  wear: z.number(),
  pressure: z.number(),
  brakeTempC: z.number(),
});

// Same per-corner tyre read the review UI shows (client/src/components/tunes/
// TuneReviewDashboard.tsx::tireSnapshot) — reimplemented here since that file
// is client-only. Wear is the LAST frame's value (cumulative), everything
// else is a lap-average.
function tireSnapshot(pkts: TelemetryPacket[]): Record<"FL" | "FR" | "RL" | "RR", { tempC: number; wear: number; pressure: number; brakeTempC: number }> | null {
  if (pkts.length === 0) return null;
  const last = pkts[pkts.length - 1]!;
  const avg = (sel: (p: TelemetryPacket) => number | undefined) => {
    let s = 0;
    for (const p of pkts) s += sel(p) ?? 0;
    return s / pkts.length;
  };
  return {
    FL: { tempC: avg((p) => p.TireTempFL), wear: last.TireWearFL, pressure: avg((p) => p.TirePressureFrontLeft), brakeTempC: avg((p) => p.BrakeTempFrontLeft) },
    FR: { tempC: avg((p) => p.TireTempFR), wear: last.TireWearFR, pressure: avg((p) => p.TirePressureFrontRight), brakeTempC: avg((p) => p.BrakeTempFrontRight) },
    RL: { tempC: avg((p) => p.TireTempRL), wear: last.TireWearRL, pressure: avg((p) => p.TirePressureRearLeft), brakeTempC: avg((p) => p.BrakeTempRearLeft) },
    RR: { tempC: avg((p) => p.TireTempRR), wear: last.TireWearRR, pressure: avg((p) => p.TirePressureRearRight), brakeTempC: avg((p) => p.BrakeTempRearRight) },
  };
}

// Cap on how many laps get_lap_issues walks when no lapId is given — mirrors
// clean-lap-aggregate.ts's MAX_CLEAN_LAPS: beyond this the per-lap telemetry
// fetch cost isn't worth it for a chat-turn tool call.
const MAX_ISSUE_LAPS = 8;
// Matches loadRepresentativeLap's/clean-lap-aggregate's analysable-lap gate.
const MIN_TELEMETRY_FRAMES = 30;

export function buildSetupEngineerLapSummaries(laps: LapMeta[]) {
  const selection = selectEvaluationLaps(laps, Number.POSITIVE_INFINITY);
  const bestLapTime = selection.chosen[0]?.lapTime ?? null;
  return laps.map((lap) => {
    const decision = selection.rejectionDecisionById.get(lap.id) ?? selection.setupDecision;
    const analysisEligible = selection.chosenIds.has(lap.id);
    return {
      lapId: lap.id,
      lapNumber: lap.lapNumber,
      lapTime: lap.lapTime,
      isValid: lap.isValid,
      excluded: Boolean(lap.experimentExcluded),
      analysisEligible,
      eligibilityStatus: decision.status,
      reasonCodes: analysisEligible ? decision.reasons.map(({ code }) => code) : [...(selection.reasonCodesById.get(lap.id) ?? [])],
      s1Time: lap.sectorTimes?.[0] ?? null,
      s2Time: lap.sectorTimes?.[1] ?? null,
      s3Time: lap.sectorTimes?.[2] ?? null,
      deltaToBestSec: bestLapTime != null && analysisEligible ? lap.lapTime - bestLapTime : null,
    };
  });
}

export function buildSetupEngineerTools() {
  const getSetupTool = createTool({
    id: "get-setup",
    description:
      "Get the active setup version's tunable knobs: current value, min/max clamp range, and the " +
      "per-magnitude (small/medium/large) step size. This is the COMPLETE list of knobs you may ever " +
      "recommend or move — never suggest a change to anything not in this list.",
    inputSchema: NoInput,
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      version: z.number().optional(),
      knobs: z
        .array(
          z.object({
            component: z.string(),
            current: z.number().nullable(),
            min: z.number(),
            max: z.number(),
            step: z.object({ small: z.number(), medium: z.number(), large: z.number() }),
          }),
        )
        .default([]),
    }),
    execute: async (_input, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
      const ctx = await loadActiveExperimentContext(sessionId);
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
      "Get the deterministic symptom report computed from the shared setup-analysis lap pool. " +
      "Returns the exact policy status and machine-readable reason codes. Unknown or ineligible " +
      "evidence is unavailable and must not be used for setup conclusions.",
    inputSchema: NoInput,
    outputSchema: z.object({
      available: z.boolean(),
      summary: z.string(),
      eligibilityStatus: EligibilityStatusEnum,
      reasonCodes: z.array(z.string()),
    }),
    execute: async (_input, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
      const agg = await loadCleanLapAggregate(sessionId);
      const eligibilityStatus = agg.setupDecision.status;
      const reasonCodes = agg.setupDecision.reasons.map((reason) => reason.code);
      if (!agg.symptoms) {
        return {
          available: false,
          summary: eligibilityDecisionText(agg.setupDecision),
          eligibilityStatus,
          reasonCodes,
        };
      }
      return {
        available: true,
        summary: formatSymptoms(agg.symptoms),
        eligibilityStatus,
        reasonCodes,
      };
    },
  });

  const getTrackConditionsTool = createTool({
    id: "get-track-conditions",
    description:
      "Get deterministic weather / track-surface conditions from the same shared setup-analysis " +
      "lap pool as the symptom report. Returns the exact policy status and machine-readable reason " +
      "codes. Unknown or ineligible evidence is unavailable.",
    inputSchema: NoInput,
    outputSchema: z.object({
      available: z.boolean(),
      summary: z.string(),
      eligibilityStatus: EligibilityStatusEnum,
      reasonCodes: z.array(z.string()),
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
      const agg = await loadCleanLapAggregate(sessionId);
      const eligibilityStatus = agg.setupDecision.status;
      const reasonCodes = agg.setupDecision.reasons.map((reason) => reason.code);
      const tc = agg.trackConditions;
      if (!tc) {
        return {
          available: false,
          summary: eligibilityDecisionText(agg.setupDecision),
          eligibilityStatus,
          reasonCodes,
        };
      }
      return {
        available: true,
        summary: formatTrackConditions(tc),
        eligibilityStatus,
        reasonCodes,
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
      "Delegate corner-by-corner driving/telemetry analysis of the shared policy-selected lap to " +
      "the Lap Analyst. Use this when the driver asks where time is lost or whether a problem is " +
      "driving rather than setup. Returns exact eligibility status and machine-readable reason codes; " +
      "unknown or ineligible evidence is unavailable.",
    inputSchema: NoInput,
    outputSchema: z.object({
      available: z.boolean(),
      summary: z.string(),
      eligibilityStatus: EligibilityStatusEnum,
      reasonCodes: z.array(z.string()),
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
      versions: z.array(
        z.object({
          version: z.number(),
          label: z.string(),
          engine: z.string().nullable(),
          driverComment: z.string().nullable(),
          notes: z.string().nullable(),
          changes: z.array(
            z.object({
              component: z.string(),
              from: z.number(),
              to: z.number(),
              direction: z.string(),
            }),
          ),
        }),
      ),
    }),
    execute: async (_input, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
      const ctx = await loadActiveExperimentContext(sessionId);
      const tests = ctx.ok ? ctx.tests : [];
      return {
        versions: tests.map((t) => {
          let changes: { component: string; from: number; to: number; direction: string }[] = [];
          if (t.appliedChanges) {
            try {
              const parsed = JSON.parse(t.appliedChanges);
              if (Array.isArray(parsed)) changes = parsed;
            } catch {
              /* malformed history row — surface as no changes */
            }
          }
          return {
            version: t.version,
            label: t.label,
            engine: t.engine,
            driverComment: t.driverComment,
            notes: t.notes ?? null,
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
      const ctx = await loadActiveExperimentContext(sessionId);
      if (!ctx.ok) return { ok: false, error: ctx.error };
      const { setup, applied, skipped } = applyIntents(ctx.gameId, ctx.setup, [
        {
          component: inputData.component,
          direction: inputData.direction as TuneDirection,
          magnitude: inputData.magnitude as TuneMagnitude,
          reason: "preview",
        },
      ]);
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
      "explicitly confirmed they want it applied/generated. To create a child of a specific version (e.g. " +
      "several experimental children of v1), pass `target` — do NOT use branch-from-version for that, since " +
      "a plain branch is a byte-copy with no changes recorded.",
    inputSchema: z.object({
      changes: z
        .array(
          z.object({
            component: z.string(),
            direction: DirectionEnum,
            magnitude: MagnitudeEnum,
            reason: z.string().describe("One short sentence: why this change, grounded in the symptoms/conversation."),
          }),
        )
        .min(1),
      goal: z.string().describe('One short line: the driver\'s goal for this version, e.g. "faster straight speed", "stiffer suspension". Stored on the version and shown in the tree.'),
      driverConfirmed: z
        .boolean()
        .describe(
          'true ONLY if the driver explicitly approved this exact set of changes in a message AFTER you proposed it (e.g. "yes", "apply that"). false if you have not yet proposed the changes and been told to go ahead.',
        ),
      target: z.string().optional().describe("Label or version number to apply the changes on top of (becomes the new version's parent). Omit to apply on the current head."),
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
      // Hard gate: the model must attest the driver approved the proposal.
      // Weak local models skip the propose→confirm step and jump straight to
      // apply (observed: 6 unconfirmed suspension changes); refusing here
      // forces them back into preview + ask before anything is written.
      if (!inputData.driverConfirmed) {
        return {
          ok: false,
          error:
            "Not applied — driver has not confirmed. First propose the change(s) with preview_change and " +
            "their goal, ask the driver, and only call apply_changes (driverConfirmed: true) after they " +
            "explicitly say yes.",
          applied: [],
          skipped: [],
        };
      }
      const turnMessages = execCtx?.requestContext?.get(CHAT_TURN_MESSAGES_KEY);
      if (Array.isArray(turnMessages) && !inputData.changes.every((change) => hasExplicitChangeConfirmation(turnMessages as { role?: string; parts?: unknown[]; content?: unknown }[], change))) {
        return {
          ok: false,
          error: "Not applied — explicit confirmation must follow a matching preview in a later driver message.",
          applied: [],
          skipped: [],
        };
      }
      const ctx = await loadActiveExperimentContext(sessionId);
      if (!ctx.ok) return { ok: false, error: ctx.error, applied: [], skipped: [] };

      // Optional explicit base: apply on top of a named version instead of the
      // head. This is how "make N children of vX" works — each child forks off
      // vX with its own recorded changes, instead of byte-copy branches.
      let baseSetup = ctx.setup;
      let baseRealPath = ctx.realPath;
      let baseDir = ctx.baseDir;
      let parent = ctx.activeTest;
      if (inputData.target) {
        const target = inputData.target.trim().replace(/^v/i, "");
        const asNum = Number(target);
        const match =
          ctx.tests.find((t) => t.label.toLowerCase() === inputData.target!.trim().toLowerCase()) ??
          ctx.tests.find((t) => t.label.toLowerCase() === target.toLowerCase()) ??
          (Number.isFinite(asNum) ? ctx.tests.find((t) => t.version === asNum) : undefined);
        if (!match) return { ok: false, error: `No version matching "${inputData.target}" in this session.`, applied: [], skipped: [] };
        const guarded = await readActiveSetup(ctx.gameId, { setupPath: match.setupPath ?? null, setupSnapshot: match.setupSnapshot ?? null });
        if (!guarded.ok) return { ok: false, error: `Could not read ${match.label}: ${guarded.error}`, applied: [], skipped: [] };
        baseSetup = guarded.setup;
        baseRealPath = guarded.realPath;
        baseDir = guarded.baseDir;
        parent = match;
      }

      const intents = inputData.changes.map((c) => ({
        component: c.component,
        direction: c.direction as TuneDirection,
        magnitude: c.magnitude as TuneMagnitude,
        reason: c.reason,
      }));
      const { setup, applied, skipped } = applyIntents(ctx.gameId, baseSetup, intents);
      // No-op guard: if every requested change was skipped there is nothing to
      // write — creating a version anyway produces a phantom empty node in the
      // tree (observed: all changes skipped yet a new version appeared).
      if (applied.length === 0) {
        return {
          ok: false,
          error:
            "Not applied — none of the requested changes could be applied; no new version was created. " +
            "Inspect the `skipped` reasons below, fix the component names/values, and do NOT retry the " +
            "same changes unchanged.",
          applied: [],
          skipped,
        };
      }
      // From the DB, not from `ctx.tests`: that list excludes soft-deleted rows,
      // so a max over it reissues the version number of a deleted arm.
      const nextVer = await nextVersion(sessionId);

      // Branch-relative label off the head/parent. existingChildCount = how many
      // children the parent already has (its continuation + any forks).
      const parentLabel = parent?.label ?? "v1";
      const childCount = parent ? ctx.tests.filter((t) => t.parentVersionId === parent.id).length : 0;
      const takenLabels = new Set(ctx.tests.map((t) => t.label));
      const label = nextFreeLabel(computeChildLabel(parentLabel, childCount), takenLabels);
      // Descriptive slug from what actually changed, e.g. "soft-rarb" —
      // makes files readable at a glance in-game ("mugello-soft-rarb-v3").
      const slug = changeSlug(applied);
      // ACC/AC-EVO: "<session name>-<label>[-<slug>]". Session name leads so a
      // session's files group together in-game, then version label so they
      // sort/scan by version ("evening-stint-v3-soft-rarb"); F1 has no file,
      // so the label + slug alone name the advisory diff.
      const descriptive = slug ? `${label}-${slug}` : label;
      const stem = gameHasSetupFile(ctx.gameId) ? `${ctx.session.name}-${descriptive}` : descriptive;

      let written: ReturnType<typeof writeAppliedSetup>;
      try {
        written = writeAppliedSetup(ctx.gameId, { baseDir, realPath: baseRealPath, setup, stem });
      } catch (err: any) {
        return { ok: false, error: `Write failed: ${err.message}`, applied: [], skipped: [] };
      }

      const newTestId = await createExperimentVersion({
        experimentId: sessionId,
        version: nextVer,
        label,
        setupPath: written.setupPath,
        setupSnapshot: written.setupSnapshot,
        parentVersionId: parent?.id ?? null,
        appliedChanges: applied.length ? JSON.stringify(applied) : null,
        driverComment: null,
        notes: inputData.goal?.trim() || null,
        engine: "llm",
      });

      // Branch grows and head follows the work: the new node becomes the head.
      //
      // The head we are about to overwrite is the SESSION's head, not the
      // parent: with `target` set, the new arm branches off some other version
      // while the head sits elsewhere, and undo must restore where the driver
      // actually was. Matches every other recordAction call site
      // (`server/routes/experiments/version-routes.ts`).
      const prevHeadTestId = ctx.session.headVersionId ?? parent?.id ?? null;
      try {
        await setSessionHead(sessionId, newTestId);
      } catch (err: any) {
        console.error("[SetupEngineer] Failed to advance head:", err?.message);
      }

      // Push the new version to any open clients so the tree + head update
      // live, as each version lands — not batched at end-of-turn. No-op when
      // no clients are connected.
      wsManager.broadcastNotification({ type: "experiment-updated", sessionId });

      // Best-effort: an action-log write failure must not fail the apply —
      // the file + tuning test + head are already committed.
      try {
        await recordAction(sessionId, "apply-changes", { versionId: newTestId, prevHeadTestId });
      } catch (err: any) {
        console.error("[SetupEngineer] Failed to log apply-changes action:", err?.message);
      }

      // Best-effort: a memory write failure must not fail the apply — the
      // file + tuning test are already committed.
      try {
        await saveAssistantChatMessage(tuneSessionThreadId(sessionId), buildAppliedChangesMarkdown(label, applied, written.fileName, gameHasSetupFile(ctx.gameId), inputData.goal?.trim() || null));
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
      const { ok, prev } = await setLapExperimentExcluded(inputData.lapId, inputData.excluded);
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

  const updateNotesTool = createTool({
    id: "update-notes",
    description:
      "Write YOUR engineer note on a setup version node: your reasoning about the version (why a change was " +
      "made, what to try next). Engineer notes are shown back to you in VERSION HISTORY every turn, so use " +
      "this to persist context that must survive the conversation being summarised (compaction); the driver " +
      "cannot edit it. To record what the DRIVER said about how the car felt, use `record_driver_notes` " +
      "instead. Defaults to the current version; pass `version` to annotate an earlier one. This OVERWRITES " +
      "the note, so include anything from the existing note you want to keep. Pass an empty note to clear it.",
    inputSchema: z.object({
      version: z.number().int().positive().optional().describe("Version number to annotate. Omit to note the current (head) version."),
      note: z.string().max(4000).describe("The note text. Empty string clears the note."),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      version: z.number().optional(),
    }),
    execute: async (inputData, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);

      // Resolve the target node — the requested version, or the head when the
      // model didn't name one.
      let target: { id: number; version: number } | undefined;
      if (inputData.version != null) {
        const t = await getExperimentVersionsByLabel(sessionId, inputData.version);
        if (!t) return { ok: false, error: `No version ${inputData.version} in this session.` };
        target = { id: t.id, version: t.version };
      } else {
        const headId = await resolveActiveTestId(sessionId);
        if (headId == null) return { ok: false, error: "No version exists yet to attach a note to." };
        const t = await getExperimentVersion(headId);
        if (!t) return { ok: false, error: "No version exists yet to attach a note to." };
        target = { id: t.id, version: t.version };
      }

      const note = inputData.note.trim() === "" ? null : inputData.note;

      // Write the engineer note, capturing the prior value for undo.
      const prevNotes = await setExperimentVersionNotes(target.id, note);
      wsManager.broadcastNotification({ type: "experiment-updated", sessionId });
      try {
        await recordAction(sessionId, "edit-test-notes", { versionId: target.id, prevNotes });
      } catch (err: any) {
        console.error("[SetupEngineer] Failed to log edit-test-notes action:", err?.message);
      }

      return { ok: true, version: target.version };
    },
  });

  const recordDriverNotesTool = createTool({
    id: "record-driver-notes",
    description:
      "Record the DRIVER's notes on a setup version node — how the lap felt and any issues they reported " +
      "(understeer, snap on throttle, locking fronts, kerb strikes, tyre drop-off...). Call this whenever the " +
      "driver describes the car's behaviour, not just when they ask you to. This OVERWRITES the driver note " +
      "on the version, so re-summarise the existing note together with the new report and send the combined " +
      "text; pass an empty note to clear it. CONFIRM FIRST: read your proposed note text back to the driver " +
      "and only call this with `driverConfirmed: true` after they approve it in a later message. Defaults to " +
      "the current version; pass `version` to annotate an earlier one.",
    inputSchema: z.object({
      version: z.number().int().positive().optional().describe("Version number to annotate. Omit to note the current (head) version."),
      note: z.string().max(4000).describe("The driver's notes, in their terms — feel and issues. Empty string clears the note."),
      driverConfirmed: z
        .boolean()
        .describe("true ONLY if the driver explicitly approved this exact note text in a message AFTER you read it back to them. false if you have not yet shown them the wording."),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      version: z.number().optional(),
    }),
    execute: async (inputData, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);

      if (!inputData.driverConfirmed) {
        return {
          ok: false,
          error:
            "Driver notes overwrite the existing note, so they must be confirmed first. Show the driver the " +
            "exact note you want to save, then call record_driver_notes (driverConfirmed: true) once they " +
            "approve the wording.",
        };
      }

      // Resolve the target node — the requested version, or the head when the
      // model didn't name one.
      let target: { id: number; version: number } | undefined;
      if (inputData.version != null) {
        const t = await getExperimentVersionsByLabel(sessionId, inputData.version);
        if (!t) return { ok: false, error: `No version ${inputData.version} in this session.` };
        target = { id: t.id, version: t.version };
      } else {
        const headId = await resolveActiveTestId(sessionId);
        if (headId == null) return { ok: false, error: "No version exists yet to attach a note to." };
        const t = await getExperimentVersion(headId);
        if (!t) return { ok: false, error: "No version exists yet to attach a note to." };
        target = { id: t.id, version: t.version };
      }

      const note = inputData.note.trim() === "" ? null : inputData.note;

      const prev = await setExperimentVersionNote(target.id, note);
      wsManager.broadcastNotification({ type: "experiment-updated", sessionId });
      try {
        await recordAction(sessionId, "edit-test-note", { versionId: target.id, prevDriverComment: prev });
      } catch (err: any) {
        console.error("[SetupEngineer] Failed to log edit-test-note action:", err?.message);
      }

      return { ok: true, version: target.version };
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
      corners: z
        .array(
          z.object({
            corner: z.string(),
            lateralSpreadM: z.number(),
            brakeVar: z.number(),
            throttleVar: z.number(),
            lowTrust: z.boolean(),
          }),
        )
        .default([]),
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

  const listLapsTool = createTool({
    id: "list-laps",
    description:
      "Read-only. List every lap in this tuning session with structural validity, shared setup-analysis " +
      "eligibility status, exact machine-readable reason codes, and delta to best policy-selected lap. " +
      "Compact — no telemetry arrays. Use before inspecting or comparing specific laps.",
    inputSchema: NoInput,
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      laps: z
        .array(
          z.object({
            lapId: z.number(),
            lapNumber: z.number(),
            lapTime: z.number(),
            isValid: z.boolean(),
            excluded: z.boolean(),
            analysisEligible: z.boolean(),
            eligibilityStatus: EligibilityStatusEnum,
            reasonCodes: z.array(z.string()),
            s1Time: z.number().nullable(),
            s2Time: z.number().nullable(),
            s3Time: z.number().nullable(),
            deltaToBestSec: z.number().nullable(),
          }),
        )
        .default([]),
    }),
    execute: async (_input, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
      const laps = await getLapsForExperiment(sessionId);
      return {
        ok: true,
        laps: buildSetupEngineerLapSummaries(laps),
      };
    },
  });

  const getLapDetailTool = createTool({
    id: "get-lap-detail",
    description:
      "Read-only. Full review detail for ONE lap in this session: sector times, a per-corner summary " +
      "(label, apex speed, band), per-tyre wear/temperature/pressure/brake-temp, and lap-average metrics " +
      "(top speed, avg throttle/brake). Rejects a lapId that isn't in this session. Use after list_laps to " +
      "inspect a specific lap the driver asks about.",
    inputSchema: z.object({ lapId: z.number().int().positive() }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      lapNumber: z.number().optional(),
      lapTime: z.number().optional(),
      isValid: z.boolean().optional(),
      excluded: z.boolean().optional(),
      s1Time: z.number().nullable().optional(),
      s2Time: z.number().nullable().optional(),
      s3Time: z.number().nullable().optional(),
      corners: z
        .array(
          z.object({
            label: z.string(),
            minSpeedKph: z.number().optional(),
          }),
        )
        .optional(),
      tires: z
        .object({
          FL: CornerSnapShape,
          FR: CornerSnapShape,
          RL: CornerSnapShape,
          RR: CornerSnapShape,
        })
        .nullable()
        .optional(),
      metrics: z
        .object({
          topSpeedKph: z.number(),
          avgThrottle: z.number(),
          avgBrake: z.number(),
        })
        .nullable()
        .optional(),
    }),
    execute: async (inputData, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
      const sessionLaps = await getLapsForExperiment(sessionId);
      const meta = sessionLaps.find((l) => l.id === inputData.lapId);
      if (!meta) return { ok: false, error: `Lap ${inputData.lapId} is not in this session.` };

      const lap = await getLapById(inputData.lapId);
      if (!lap) return { ok: false, error: `Lap ${inputData.lapId} not found.` };

      const telemetry = lap.telemetry;
      if (telemetry.length === 0) {
        return {
          ok: true,
          lapNumber: meta.lapNumber,
          lapTime: meta.lapTime,
          isValid: meta.isValid,
          excluded: Boolean(meta.experimentExcluded),
          s1Time: meta.sectorTimes?.[0] ?? null,
          s2Time: meta.sectorTimes?.[1] ?? null,
          s3Time: meta.sectorTimes?.[2] ?? null,
          corners: [],
          tires: null,
          metrics: null,
        };
      }

      const corners = detectCorners(telemetry).map((c) => ({ label: c.label, minSpeedKph: c.minSpeedKph }));
      const topSpeedKph = telemetry.reduce((max, p) => Math.max(max, p.Speed * 3.6), 0);
      const avg = (sel: (p: TelemetryPacket) => number) => telemetry.reduce((s, p) => s + sel(p), 0) / telemetry.length;

      return {
        ok: true,
        lapNumber: meta.lapNumber,
        lapTime: meta.lapTime,
        isValid: meta.isValid,
        excluded: Boolean(meta.experimentExcluded),
        s1Time: meta.sectorTimes?.[0] ?? null,
        s2Time: meta.sectorTimes?.[1] ?? null,
        s3Time: meta.sectorTimes?.[2] ?? null,
        corners,
        tires: tireSnapshot(telemetry),
        metrics: {
          topSpeedKph,
          avgThrottle: avg((p) => p.Accel ?? 0),
          avgBrake: avg((p) => p.Brake ?? 0),
        },
      };
    },
  });

  const getLapIssuesTool = createTool({
    id: "get-lap-issues",
    description:
      "Read-only. Detect handling issues only from laps accepted by shared setup-analysis policy. " +
      "Pass lapId for one lap; omit it to scan policy-selected laps (capped). Unknown/ineligible " +
      "laps are rejected with exact machine-readable policy reason codes.",
    inputSchema: z.object({ lapId: z.number().int().positive().optional() }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      truncated: z.boolean().optional(),
      laps: z
        .array(
          z.object({
            lapId: z.number(),
            lapNumber: z.number(),
            issues: z.array(IssueShape),
          }),
        )
        .default([]),
    }),
    execute: async (inputData, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
      const sessionLaps = await getLapsForExperiment(sessionId);
      const selection = selectEvaluationLaps(sessionLaps, Number.POSITIVE_INFINITY);

      const issuesForLap = async (meta: (typeof sessionLaps)[number]) => {
        const lap = await getLapById(meta.id);
        if (!lap || lap.telemetry.length < MIN_TELEMETRY_FRAMES) return null;
        const corners = detectCorners(lap.telemetry);
        const symptoms = telemetryToSymptoms(lap.telemetry, corners);
        return symptomsToIssues(symptoms, meta.lapNumber);
      };

      if (inputData.lapId != null) {
        const meta = sessionLaps.find((l) => l.id === inputData.lapId);
        if (!meta) return { ok: false, error: `Lap ${inputData.lapId} is not in this session.`, laps: [] };
        const selectionReason = selection.reasonById.get(meta.id);
        if (selectionReason === "invalid") {
          return {
            ok: false,
            error: `Lap ${meta.id} is structurally invalid and cannot support handling conclusions.`,
            laps: [],
          };
        }
        if (selectionReason === "manual") {
          return {
            ok: false,
            error: `Lap ${meta.id} was manually excluded from setup analysis.`,
            laps: [],
          };
        }
        if (!selection.chosenIds.has(meta.id)) {
          const decision = selection.rejectionDecisionById.get(meta.id) ?? selection.setupDecision;
          const codes = selection.reasonCodesById.get(meta.id) ?? [];
          return {
            ok: false,
            error: `Lap ${meta.id} is ${decision.status} for ${decision.policyId}: ${codes.join(", ") || "no policy reason"}.`,
            laps: [],
          };
        }
        const issues = await issuesForLap(meta);
        if (issues == null) return { ok: false, error: `Lap ${inputData.lapId} has no analysable telemetry.`, laps: [] };
        return { ok: true, laps: [{ lapId: meta.id, lapNumber: meta.lapNumber, issues }] };
      }

      const analysable = selection.chosen;
      const truncated = analysable.length > MAX_ISSUE_LAPS;
      const scoped = analysable.slice(0, MAX_ISSUE_LAPS);
      const laps: { lapId: number; lapNumber: number; issues: ReturnType<typeof symptomsToIssues> }[] = [];
      for (const meta of scoped) {
        const issues = await issuesForLap(meta);
        if (issues != null) laps.push({ lapId: meta.id, lapNumber: meta.lapNumber, issues });
      }
      return { ok: true, truncated, laps };
    },
  });

  const compareLapsTool = createTool({
    id: "compare-laps",
    description:
      "Read-only. Head-to-head comparison of two laps in this session: overall time delta and a per-corner " +
      "time-delta breakdown, via the SAME comparison engine the lap-compare view uses. No raw telemetry traces " +
      "returned — just the deltas. Rejects a lapId that isn't in this session.",
    inputSchema: z.object({
      lapId1: z.number().int().positive(),
      lapId2: z.number().int().positive(),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      lapA: z.object({ lapId: z.number(), lapNumber: z.number(), lapTime: z.number() }).optional(),
      lapB: z.object({ lapId: z.number(), lapNumber: z.number(), lapTime: z.number() }).optional(),
      timeDeltaSec: z.number().optional().describe("Final cumulative delta: positive = lap A slower overall."),
      corners: z
        .array(
          z.object({
            label: z.string(),
            deltaSeconds: z.number(),
            timeA: z.number(),
            timeB: z.number(),
          }),
        )
        .optional(),
    }),
    execute: async (inputData, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
      if (inputData.lapId1 === inputData.lapId2) return { ok: false, error: "Cannot compare a lap with itself." };

      const sessionLaps = await getLapsForExperiment(sessionId);
      const metaA = sessionLaps.find((l) => l.id === inputData.lapId1);
      const metaB = sessionLaps.find((l) => l.id === inputData.lapId2);
      if (!metaA) return { ok: false, error: `Lap ${inputData.lapId1} is not in this session.` };
      if (!metaB) return { ok: false, error: `Lap ${inputData.lapId2} is not in this session.` };

      const lapA = await getLapById(inputData.lapId1);
      const lapB = await getLapById(inputData.lapId2);
      if (!lapA || !lapB) return { ok: false, error: "One or both laps could not be loaded." };
      if (lapA.telemetry.length === 0 || lapB.telemetry.length === 0) {
        return { ok: false, error: "One or both laps have no telemetry data." };
      }
      const corners = detectCorners(lapA.telemetry);
      const track = resolveTrack(lapA.gameId, lapA.trackOrdinal);
      const result = compareLaps(lapA.telemetry, lapB.telemetry, corners, {
        lapAIsValid: lapA.isValid,
        lapBIsValid: lapB.isValid,
        trackLengthMeters: track.lengthMeters,
      });
      const timeDeltaSec = result.timeDelta.length > 0 ? result.timeDelta[result.timeDelta.length - 1]! : 0;

      return {
        ok: true,
        lapA: { lapId: metaA.id, lapNumber: metaA.lapNumber, lapTime: metaA.lapTime },
        lapB: { lapId: metaB.id, lapNumber: metaB.lapNumber, lapTime: metaB.lapTime },
        timeDeltaSec,
        corners: result.cornerDeltas.map((c) => ({ label: c.label, deltaSeconds: c.deltaSeconds, timeA: c.timeA, timeB: c.timeB })),
      };
    },
  });

  const deleteVersionTool = createTool({
    id: "delete-version",
    description:
      "Soft-delete a setup version and its whole branch (all versions forked from it). Reversible — trashed " +
      "versions can be restored later. If the session's current head is inside the deleted branch, the head " +
      "moves to the nearest surviving ancestor automatically. Confirm with the driver before calling — this " +
      "affects a real, laps-bearing version tree, not just the one node named. Never call it until the " +
      "driver has explicitly said yes to deleting that specific version in a message after you asked.",
    inputSchema: z.object({
      versionId: z.number().int().positive(),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      deletedIds: z.array(z.number()).default([]),
      headVersionId: z.number().nullable().optional(),
    }),
    execute: async (inputData, execCtx) => {
      const { sessionId } = readSetupEngineerContext(execCtx?.requestContext);
      const ctx = await loadActiveExperimentContext(sessionId);
      if (!ctx.ok) return { ok: false, error: ctx.error, deletedIds: [] };

      const test = ctx.tests.find((t) => t.id === inputData.versionId);
      if (!test) return { ok: false, error: `No version ${inputData.versionId} found in this session.`, deletedIds: [] };

      const result = await deleteTestSubtree(sessionId, inputData.versionId, ctx.session.headVersionId ?? null);

      try {
        await recordAction(sessionId, "delete", {
          rootTestId: inputData.versionId,
          testIds: result.deletedIds,
          prevHeadTestId: result.headMoved ? result.prevHeadTestId : null,
        });
      } catch (err: any) {
        console.error("[SetupEngineer] Failed to log delete action:", err?.message);
      }

      return { ok: true, deletedIds: result.deletedIds, headVersionId: result.newHeadTestId };
    },
  });

  const undoLastActionTool = createTool({
    id: "undo-last-action",
    description:
      "Undo the most recent action taken in this session (apply/branch/add-base/inspire/import/set-head/delete/" +
      'restore/rename/exclude) — user or AI. Use when the driver says "undo that" / "undo the last change" / ' +
      '"go back". Reverses exactly one action per call; call again to go further back. If undoing a version ' +
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
          await saveAssistantChatMessage(tuneSessionThreadId(sessionId), result.warning ? `Undone — ${result.warning}` : `Undone (${result.kind}).`);
        } catch (err: any) {
          console.error("[SetupEngineer] Failed to post undo note:", err?.message);
        }
      }

      return result;
    },
  });

  return {
    getSetupTool,
    getSymptomsTool,
    getTrackConditionsTool,
    consultLapAnalystTool,
    getVersionHistoryTool,
    previewChangeTool,
    applyChangesTool,
    setLapExcludedTool,
    updateNotesTool,
    recordDriverNotesTool,
    compareLapConsistencyTool,
    deleteVersionTool,
    undoLastActionTool,
    listLapsTool,
    getLapDetailTool,
    getLapIssuesTool,
    compareLapsTool,
  };
}

/**
 * Module-level singleton tool set — registered on the Mastra instance so Mastra
 * Studio lists them. Session binding is an explicit `sessionId` parameter on
 * every tool, supplied by the caller per call.
 */
export const setupEngineerTools = buildSetupEngineerTools();
