/**
 * apply_changes no-op guard (FIX A) + system-prompt mandates (FIX B).
 *
 * Unlike test/setup-engineer-tools.test.ts (pure primitives only), this file
 * DOES import `mastra/tools/setup-engineer.ts` — but only after stubbing every
 * side-effectful module it wires (DB/fs/ws/memory) via `mock.module`, so the
 * deterministic `applyIntents` engine stays REAL while writes are observable
 * fakes. The scenario: every requested change is skipped by `applyIntents`
 * (unknown components), so `applied` is empty — the tool must refuse and MUST
 * NOT create a phantom version (no writeAppliedSetup / createTuningTest /
 * setSessionHead calls).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// `mock.module` is PROCESS-global in Bun and cannot be undone: re-mocking an
// already-mocked path is a no-op, so an `afterAll` "restore" achieves nothing
// and every later test file in the run would import these stubs (which is how
// the tuning/chat suites started seeing `createTuningTest() === 999`).
//
// So the stubs are *gated dispatchers*: each one delegates to the real export
// unless `stubsActive` is set, and only this file's tests set it. Real
// namespaces are captured by static import, which evaluates before any
// `mock.module` call below.
import * as RealSetupIo from "../server/ai/setup-io";
import * as RealTestQueries from "../server/db/tuning-test-queries";
import * as RealSessionQueries from "../server/db/tuning-session-queries";
import * as RealChatAgent from "../server/ai/chat-agent";
import * as RealEngineerContext from "../server/ai/setup-engineer-context";
import * as RealQueries from "../server/db/queries";
import * as RealActionQueries from "../server/db/tuning-action-queries";
import * as RealUndo from "../server/tuning-undo";
import * as RealConsult from "../server/ai/consult-lap-analyst";
import * as RealCleanLap from "../server/ai/clean-lap-aggregate";
import * as RealComparison from "../server/comparison";
import * as RealSettings from "../server/settings";
import * as RealMastraModel from "../mastra/model";

let stubsActive = false;
beforeAll(() => {
  stubsActive = true;
});
afterAll(() => {
  stubsActive = false;
});

/** Route calls through `fake` while this file's tests run, else through `real`. */
function gate<F extends (...args: any[]) => any>(real: F, fake: (...args: any[]) => any): F {
  return ((...args: any[]) => (stubsActive ? fake(...args) : real(...args))) as F;
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
const writeAppliedSetup = mock(() => ({ setupPath: "fake/path.json", setupSnapshot: null, fileName: "fake.json" }));
const readActiveSetup = mock(async () => ({ ok: true, setup: baseAccSetup(), realPath: "fake/base.json", baseDir: "fake" }));
const createTuningTest = mock(async () => 999);
const setSessionHead = mock(async () => {});
const recordAction = mock(async () => {});
const setTuningTestNote = mock(async () => null);

const fakeCtx = {
  ok: true as const,
  gameId: "acc",
  session: { id: 61, name: "guard-test", headTestId: 1 },
  tests: [{ id: 1, version: 1, label: "v1", parentTestId: null, setupPath: "fake/base.json", setupSnapshot: null }],
  activeTest: { id: 1, version: 1, label: "v1", parentTestId: null, setupPath: "fake/base.json", setupSnapshot: null },
  baseDir: "fake",
  realPath: "fake/base.json",
  setup: baseAccSetup(),
};

mock.module("../server/ai/setup-io", () => ({
  ...RealSetupIo,
  readActiveSetup: gate(RealSetupIo.readActiveSetup, readActiveSetup),
  writeAppliedSetup: gate(RealSetupIo.writeAppliedSetup, writeAppliedSetup),
}));
mock.module("../server/db/tuning-test-queries", () => ({
  ...RealTestQueries,
  createTuningTest: gate(RealTestQueries.createTuningTest, createTuningTest),
  deleteTestSubtree: gate(RealTestQueries.deleteTestSubtree, mock(async () => {})),
  getTuningTest: gate(RealTestQueries.getTuningTest, mock(async () => ({ id: 1, version: 1 }))),
  getTuningTestByVersion: gate(RealTestQueries.getTuningTestByVersion, mock(async () => null)),
  resolveActiveTestId: gate(RealTestQueries.resolveActiveTestId, mock(async () => 1)),
  setTuningTestNote: gate(RealTestQueries.setTuningTestNote, setTuningTestNote),
  setTuningTestNotes: gate(RealTestQueries.setTuningTestNotes, mock(async () => {})),
}));
mock.module("../server/db/tuning-session-queries", () => ({
  ...RealSessionQueries,
  setSessionHead: gate(RealSessionQueries.setSessionHead, setSessionHead),
}));
mock.module("../server/ai/chat-agent", () => ({
  ...RealChatAgent,
  saveAssistantChatMessage: gate(RealChatAgent.saveAssistantChatMessage, mock(async () => {})),
  getChatMemory: gate(RealChatAgent.getChatMemory, mock(() => null)),
}));
mock.module("../server/ai/setup-engineer-context", () => ({
  ...RealEngineerContext,
  buildAppliedChangesMarkdown: gate(RealEngineerContext.buildAppliedChangesMarkdown, mock(() => "")),
  computeSessionSymptoms: gate(RealEngineerContext.computeSessionSymptoms, mock(async () => [])),
  computeSessionTrackConditions: gate(RealEngineerContext.computeSessionTrackConditions, mock(async () => null)),
  formatTrackConditions: gate(RealEngineerContext.formatTrackConditions, mock(() => "")),
  loadActiveTuningContext: gate(RealEngineerContext.loadActiveTuningContext, mock(async () => fakeCtx)),
}));
mock.module("../server/db/queries", () => ({
  ...RealQueries,
  setLapTuningExcluded: gate(RealQueries.setLapTuningExcluded, mock(async () => {})),
  getLapById: gate(RealQueries.getLapById, mock(async () => null)),
  getLapsForTuningSession: gate(RealQueries.getLapsForTuningSession, mock(async () => [])),
}));
mock.module("../server/db/tuning-action-queries", () => ({
  ...RealActionQueries,
  recordAction: gate(RealActionQueries.recordAction, recordAction),
}));
mock.module("../server/tuning-undo", () => ({
  ...RealUndo,
  undoLastAction: gate(RealUndo.undoLastAction, mock(async () => ({ ok: true }))),
}));
mock.module("../server/ai/consult-lap-analyst", () => ({
  ...RealConsult,
  consultLapAnalystForSession: gate(RealConsult.consultLapAnalystForSession, mock(async () => ({ ok: true, text: "" }))),
}));
mock.module("../server/ai/clean-lap-aggregate", () => ({
  ...RealCleanLap,
  loadCleanLapAggregate: gate(RealCleanLap.loadCleanLapAggregate, mock(async () => null)),
}));
mock.module("../server/comparison", () => ({
  ...RealComparison,
  compareLaps: gate(RealComparison.compareLaps, mock(() => ({}))),
}));
mock.module("../server/settings", () => ({
  ...RealSettings,
  loadSettings: gate(RealSettings.loadSettings, mock(() => ({ ai: {} }))),
}));
mock.module("../mastra/model", () => ({
  ...RealMastraModel,
  getMastraModelId: gate(RealMastraModel.getMastraModelId, mock(() => "fake/model")),
}));

const { setupEngineerTools } = await import("../mastra/tools/setup-engineer");

const requestContext = { get: (k: string) => ({ gameId: "acc", sessionId: 61 } as any)[k] };

describe("apply_changes — no-op guard when every change is skipped", () => {
  test("returns ok:false with skipped reasons and creates NO version", async () => {
    writeAppliedSetup.mockClear();
    createTuningTest.mockClear();
    setSessionHead.mockClear();

    const result: any = await setupEngineerTools.applyChangesTool.execute!(
      {
        changes: [
          { component: "Front Anti-Roll Bar Stiffness Coefficient", direction: "increase", magnitude: "small", reason: "t" },
          { component: "Rear Hyperdrive Damper", direction: "decrease", magnitude: "small", reason: "t" },
        ],
        goal: "stiffer front",
        driverConfirmed: true,
      },
      { requestContext } as any,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/skipped|applied/i);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.skipped[0]!.reason).toBeTruthy();

    // The phantom-version bug: none of these may run when nothing applied.
    expect(writeAppliedSetup).not.toHaveBeenCalled();
    expect(createTuningTest).not.toHaveBeenCalled();
    expect(setSessionHead).not.toHaveBeenCalled();
  });
});

describe("record_driver_notes — driver confirmation guard", () => {
  test("refuses to write the driver note without driverConfirmed", async () => {
    setTuningTestNote.mockClear();

    const result: any = await setupEngineerTools.recordDriverNotesTool.execute!(
      { note: "understeer on entry into T1", driverConfirmed: false },
      { requestContext } as any,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/confirm|approve/i);
    expect(setTuningTestNote).not.toHaveBeenCalled();
  });

  test("writes the note once the driver has confirmed it", async () => {
    setTuningTestNote.mockClear();

    const result: any = await setupEngineerTools.recordDriverNotesTool.execute!(
      { note: "understeer on entry into T1", driverConfirmed: true },
      { requestContext } as any,
    );

    expect(result.ok).toBe(true);
    expect(setTuningTestNote).toHaveBeenCalledTimes(1);
  });
});

describe("SETUP_ENGINEER_INSTRUCTIONS — prompt mandates", () => {
  test("mandates consult_lap_analyst before the first recommendation and refuses on unknown setup values", async () => {
    const { SETUP_ENGINEER_INSTRUCTIONS } = await import("../mastra/agents/setup-engineer");

    // 1. First-recommendation gate on the lap analyst.
    expect(SETUP_ENGINEER_INSTRUCTIONS).toMatch(/MUST call \\?`consult_lap_analyst\\?` (?:once )?before (?:making |giving )?(?:your|the) FIRST setup recommendation/i);
    // 2. None-valued knobs are untunable but must not block tuning the rest;
    //    only a fully unknown setup is a hard stop.
    expect(SETUP_ENGINEER_INSTRUCTIONS).toMatch(/value None.*never recommend or apply changes to them/i);
    expect(SETUP_ENGINEER_INSTRUCTIONS).toMatch(/ALL current setup values are unknown.*unreadable/i);
  });
});
