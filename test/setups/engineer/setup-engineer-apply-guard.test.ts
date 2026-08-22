/**
 * apply_changes no-op guard (FIX A) + system-prompt mandates (FIX B).
 *
 * Unlike test/setup-engineer-tools.test.ts (pure primitives only), this file
 * DOES import `mastra/tools/setup-engineer.ts` — but only after stubbing every
 * side-effectful module it wires (DB/fs/ws/memory) via `mock.module`, so the
 * deterministic `applyIntents` engine stays REAL while writes are observable
 * fakes. The scenario: every requested change is skipped by `applyIntents`
 * (unknown components), so `applied` is empty — the tool must refuse and MUST
 * NOT create a phantom version (no writeAppliedSetup / createExperimentVersion /
 * setSessionHead calls).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RequestContext } from "@mastra/core/request-context";
import { noopObserve, type ToolExecutionContext } from "@mastra/core/tools";
// already-mocked path is a no-op, so an `afterAll` "restore" achieves nothing
// and every later test file in the run would import these stubs (which is how
// the tuning/chat suites started seeing `createExperimentVersion() === 999`).
//
// So the stubs are *gated dispatchers*: each one delegates to the real export
// unless `stubsActive` is set, and only this file's tests set it. Real
// namespaces are captured by static import, which evaluates before any
// `mock.module` call below.
import * as RealSetupIo from "../../../server/setups/io";
import * as RealTestQueries from "../../../server/db/experiment-version-queries";
import * as RealSessionQueries from "../../../server/db/experiment-queries";
import * as RealChatAgent from "../../../server/ai/chat-agent";
import * as RealAppliedMarkdown from "../../../server/setups/applied-change-markdown";
import * as RealTrackConditions from "../../../server/ai/track-conditions";
import * as RealSetupLineage from "../../../server/experiments/setup-lineage";
import * as RealLapReadQueries from "../../../server/db/lap-read-queries";
import * as RealExperimentLapQueries from "../../../server/db/experiment-lap-queries";
import * as RealActionQueries from "../../../server/db/experiment-action-queries";
import * as RealUndo from "../../../server/experiments/undo";
import * as RealConsult from "../../../server/ai/consult-lap-analyst";
import * as RealCleanLap from "../../../server/experiments/lap-evidence/aggregate";
import * as RealComparison from "../../../server/lap-analysis/comparison";
import * as RealSettings from "../../../server/runtime/config/settings";
import * as RealMastraModel from "../../../mastra/model";

let stubsActive = false;
beforeAll(() => {
  stubsActive = true;
});
afterAll(() => {
  stubsActive = false;
});

/** Route calls through `fake` while this file's tests run, else through `real`. */
function gate<Args extends unknown[], Result>(real: (...args: Args) => Result, fake: (...args: Args) => unknown): (...args: Args) => Result {
  return (...args) => (stubsActive ? (fake(...args) as Result) : real(...args));
}

type ToolResult = { ok: boolean; error?: string };
type ApplyResult = ToolResult & { applied: unknown[]; skipped: { component: string; reason: string }[] };

function toolResult(value: unknown): ToolResult {
  if (value === null || typeof value !== "object" || !("ok" in value) || typeof value.ok !== "boolean") throw new Error("Expected tool result");
  const error = "error" in value && typeof value.error === "string" ? value.error : undefined;
  return { ok: value.ok, error };
}

function isSkippedChange(value: unknown): value is { component: string; reason: string } {
  return value !== null && typeof value === "object" && "component" in value && typeof value.component === "string" && "reason" in value && typeof value.reason === "string";
}

function applyResult(value: unknown): ApplyResult {
  const result = toolResult(value);
  if (value === null || typeof value !== "object" || !("applied" in value) || !Array.isArray(value.applied) || !("skipped" in value) || !Array.isArray(value.skipped)) {
    throw new Error("Expected apply_changes result");
  }
  const skipped = value.skipped.filter(isSkippedChange);
  if (skipped.length !== value.skipped.length) throw new Error("Expected skipped change reasons");
  return { ...result, applied: value.applied, skipped };
}

function baseAccSetup() {
  return {
    basicSetup: {
      tyres: { tyrePressure: [26, 26, 26, 26] },
    },
    advancedSetup: {
      mechanicalBalance: { aRBFront: 5, aRBRear: 5, brakeBias: 55 },
      aeroBalance: { splitter: 3, rearWing: 4, rideHeight: [65, 65, 75, 75] },
      dampers: { bumpSlow: [8, 8, 8, 8], reboundSlow: [8, 8, 8, 8] },
      drivetrain: { preload: 40 },
    },
  };
}

// --- observable fakes for the write path ------------------------------------
const setupFilePath = join(tmpdir(), "raceiq-setup-engineer-atomic-test.json");
const writeAppliedSetup = mock(() => {
  writeFileSync(setupFilePath, "{}");
  return { setupPath: setupFilePath, setupSnapshot: null, fileName: "fake.json" };
});
const readActiveSetup = mock(async () => ({ ok: true, setup: baseAccSetup(), realPath: "fake/base.json", baseDir: "fake" }));
const createExperimentVersion = mock(async () => 999);
const setSessionHead = mock(async () => {});
const deleteTestSubtree = mock(async () => {});
const recordAction = mock(async () => {});
const setExperimentVersionNote = mock(async () => null);

const fakeCtx = {
  ok: true as const,
  gameId: "acc",
  session: { id: 61, name: "guard-test", headVersionId: 1 },
  tests: [{ id: 1, version: 1, label: "v1", parentVersionId: null, setupPath: "fake/base.json", setupSnapshot: null }],
  activeTest: { id: 1, version: 1, label: "v1", parentVersionId: null, setupPath: "fake/base.json", setupSnapshot: null },
  baseDir: "fake",
  realPath: "fake/base.json",
  setup: baseAccSetup(),
};

mock.module("../../../server/setups/io", () => ({
  ...RealSetupIo,
  readActiveSetup: gate(RealSetupIo.readActiveSetup, readActiveSetup),
  writeAppliedSetup: gate(RealSetupIo.writeAppliedSetup, writeAppliedSetup),
}));
mock.module("../../../server/db/experiment-version-queries", () => ({
  ...RealTestQueries,
  createExperimentVersion: gate(RealTestQueries.createExperimentVersion, createExperimentVersion),
  deleteTestSubtree: gate(RealTestQueries.deleteTestSubtree, deleteTestSubtree),
  getExperimentVersion: gate(
    RealTestQueries.getExperimentVersion,
    mock(async () => ({ id: 1, version: 1 })),
  ),
  getExperimentVersionsByLabel: gate(
    RealTestQueries.getExperimentVersionsByLabel,
    mock(async () => null),
  ),
  resolveActiveTestId: gate(
    RealTestQueries.resolveActiveTestId,
    mock(async () => 1),
  ),
  setExperimentVersionNote: gate(RealTestQueries.setExperimentVersionNote, setExperimentVersionNote),
  setExperimentVersionNotes: gate(
    RealTestQueries.setExperimentVersionNotes,
    mock(async () => {}),
  ),
}));
mock.module("../../../server/db/experiment-queries", () => ({
  ...RealSessionQueries,
  setSessionHead: gate(RealSessionQueries.setSessionHead, setSessionHead),
}));
mock.module("../../../server/ai/chat-agent", () => ({
  ...RealChatAgent,
  saveAssistantChatMessage: gate(
    RealChatAgent.saveAssistantChatMessage,
    mock(async () => {}),
  ),
  getChatMemory: gate(
    RealChatAgent.getChatMemory,
    mock(() => null),
  ),
}));
mock.module("../../../server/setups/applied-change-markdown", () => ({
  ...RealAppliedMarkdown,
  buildAppliedChangesMarkdown: gate(
    RealAppliedMarkdown.buildAppliedChangesMarkdown,
    mock(() => ""),
  ),
}));
mock.module("../../../server/ai/track-conditions", () => ({
  ...RealTrackConditions,
  formatTrackConditions: gate(
    RealTrackConditions.formatTrackConditions,
    mock(() => ""),
  ),
}));
mock.module("../../../server/experiments/setup-lineage", () => ({
  ...RealSetupLineage,
  loadActiveExperimentContext: gate(
    RealSetupLineage.loadActiveExperimentContext,
    mock(async () => fakeCtx),
  ),
}));
mock.module("../../../server/db/lap-read-queries", () => ({
  ...RealLapReadQueries,
  getLapById: gate(
    RealLapReadQueries.getLapById,
    mock(async () => null),
  ),
}));
mock.module("../../../server/db/experiment-lap-queries", () => ({
  ...RealExperimentLapQueries,
  setLapExperimentExcluded: gate(
    RealExperimentLapQueries.setLapExperimentExcluded,
    mock(async () => {}),
  ),
  getLapsForExperiment: gate(
    RealExperimentLapQueries.getLapsForExperiment,
    mock(async () => []),
  ),
}));
mock.module("../../../server/db/experiment-action-queries", () => ({
  ...RealActionQueries,
  recordAction: gate(RealActionQueries.recordAction, recordAction),
}));
mock.module("../../../server/experiments/undo", () => ({
  ...RealUndo,
  undoLastAction: gate(
    RealUndo.undoLastAction,
    mock(async () => ({ ok: true })),
  ),
}));
mock.module("../../../server/ai/consult-lap-analyst", () => ({
  ...RealConsult,
  consultLapAnalystForSession: gate(
    RealConsult.consultLapAnalystForSession,
    mock(async () => ({ ok: true, text: "" })),
  ),
}));
mock.module("../../../server/experiments/lap-evidence/aggregate", () => ({
  ...RealCleanLap,
  loadCleanLapAggregate: gate(
    RealCleanLap.loadCleanLapAggregate,
    mock(async () => null),
  ),
}));
mock.module("../../../server/lap-analysis/comparison", () => ({
  ...RealComparison,
  compareLaps: gate(
    RealComparison.compareLaps,
    mock(() => ({})),
  ),
}));
mock.module("../../../server/runtime/config/settings", () => ({
  ...RealSettings,
  loadSettings: gate(
    RealSettings.loadSettings,
    mock(() => ({ ai: {} })),
  ),
}));
mock.module("../../../mastra/model", () => ({
  ...RealMastraModel,
  getMastraModelId: gate(
    RealMastraModel.getMastraModelId,
    mock(() => "fake/model"),
  ),
}));

const { setupEngineerTools } = await import("../../../mastra/tools/setup-engineer");

const requestContext = new RequestContext();
requestContext.set("gameId", "acc");
requestContext.set("sessionId", 61);
const executionContext: ToolExecutionContext<unknown, unknown, unknown> = {
  requestContext,
  observe: noopObserve,
};

describe("apply_changes — no-op guard when every change is skipped", () => {
  test("returns ok:false with skipped reasons and creates NO version", async () => {
    writeAppliedSetup.mockClear();
    createExperimentVersion.mockClear();
    setSessionHead.mockClear();

    const result = applyResult(
      await setupEngineerTools.applyChangesTool.execute!(
        {
          changes: [
            { component: "Front Anti-Roll Bar Stiffness Coefficient", direction: "increase" as const, magnitude: "small" as const, reason: "t" },
            { component: "Rear Hyperdrive Damper", direction: "decrease" as const, magnitude: "small" as const, reason: "t" },
          ],
          goal: "stiffer front",
          driverConfirmed: true,
        },
        executionContext,
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/skipped|applied/i);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.skipped[0]!.reason).toBeTruthy();

    // The phantom-version bug: none of these may run when nothing applied.
    expect(writeAppliedSetup).not.toHaveBeenCalled();
    expect(createExperimentVersion).not.toHaveBeenCalled();
    expect(setSessionHead).not.toHaveBeenCalled();
  });
});

describe("apply_changes — persistence compensation", () => {
  const appliedChange = {
    changes: [{ component: "Front Anti-Roll Bar", direction: "increase" as const, magnitude: "small" as const, reason: "reduce entry understeer" }],
    goal: "reduce entry understeer",
    driverConfirmed: true,
  };

  test("removes setup file when version creation fails", async () => {
    if (existsSync(setupFilePath)) unlinkSync(setupFilePath);
    writeAppliedSetup.mockClear();
    createExperimentVersion.mockReset();
    createExperimentVersion.mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValue(999);
    setSessionHead.mockClear();
    deleteTestSubtree.mockClear();
    const result = applyResult(await setupEngineerTools.applyChangesTool.execute!(appliedChange, executionContext));

    expect(result).toMatchObject({ ok: false, applied: [], skipped: [] });
    expect(result.error ?? "").toMatch(/Version create failed.*database unavailable/);
    expect(existsSync(setupFilePath)).toBe(false);
    expect(setSessionHead).not.toHaveBeenCalled();
    expect(deleteTestSubtree).not.toHaveBeenCalled();
  });

  test("returns failure and compensates version/file when head update fails", async () => {
    if (existsSync(setupFilePath)) unlinkSync(setupFilePath);
    writeAppliedSetup.mockClear();
    createExperimentVersion.mockReset();
    createExperimentVersion.mockResolvedValue(999);
    setSessionHead.mockReset();
    setSessionHead.mockRejectedValueOnce(new Error("head write failed")).mockResolvedValue(undefined);
    deleteTestSubtree.mockClear();

    const result = applyResult(await setupEngineerTools.applyChangesTool.execute!(appliedChange, executionContext));
    expect(result).toMatchObject({ ok: false, applied: [], skipped: [] });
    expect(result.error ?? "").toMatch(/Head update failed.*head write failed/);
    expect(deleteTestSubtree).toHaveBeenCalledWith(61, 999, 999);
    expect(setSessionHead).toHaveBeenNthCalledWith(1, 61, 999);
    expect(setSessionHead).toHaveBeenNthCalledWith(2, 61, 1);
    expect(existsSync(setupFilePath)).toBe(false);
  });
});

describe("record_driver_notes — driver confirmation guard", () => {
  test("refuses to write the driver note without driverConfirmed", async () => {
    setExperimentVersionNote.mockClear();

    const result = toolResult(await setupEngineerTools.recordDriverNotesTool.execute!({ note: "understeer on entry into T1", driverConfirmed: false }, executionContext));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/confirm|approve/i);
    expect(setExperimentVersionNote).not.toHaveBeenCalled();
  });

  test("writes the note once the driver has confirmed it", async () => {
    setExperimentVersionNote.mockClear();

    const result = toolResult(await setupEngineerTools.recordDriverNotesTool.execute!({ note: "understeer on entry into T1", driverConfirmed: true }, executionContext));

    expect(result.ok).toBe(true);
    expect(setExperimentVersionNote).toHaveBeenCalledTimes(1);
  });
});

describe("SETUP_ENGINEER_INSTRUCTIONS — prompt mandates", () => {
  test("mandates consult_lap_analyst before the first recommendation and refuses on unknown setup values", async () => {
    const { SETUP_ENGINEER_INSTRUCTIONS } = await import("../../../mastra/agents/setup-engineer");

    // 1. First-recommendation gate on the lap analyst.
    expect(SETUP_ENGINEER_INSTRUCTIONS).toMatch(/MUST call \\?`consult_lap_analyst\\?` (?:once )?before (?:making |giving )?(?:your|the) FIRST setup recommendation/i);
    // 2. None-valued knobs are untunable but must not block tuning the rest;
    //    only a fully unknown setup is a hard stop.
    expect(SETUP_ENGINEER_INSTRUCTIONS).toMatch(/value None.*never recommend or apply changes to them/i);
    expect(SETUP_ENGINEER_INSTRUCTIONS).toMatch(/ALL current setup values are unknown.*unreadable/i);
  });
});
