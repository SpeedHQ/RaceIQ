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
import { describe, expect, mock, test } from "bun:test";

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
const broadcastNotification = mock(() => {});

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

mock.module("../server/ai/setup-io", () => ({ readActiveSetup, writeAppliedSetup }));
mock.module("../server/db/tuning-test-queries", () => ({
  createTuningTest,
  deleteTestSubtree: mock(async () => {}),
  getTuningTest: mock(async () => null),
  getTuningTestByVersion: mock(async () => null),
  resolveActiveTestId: mock(async () => 1),
  setTuningTestNote: mock(async () => {}),
  setTuningTestNotes: mock(async () => {}),
}));
mock.module("../server/db/tuning-session-queries", () => ({ setSessionHead }));
mock.module("../server/ai/chat-agent", () => ({
  saveAssistantChatMessage: mock(async () => {}),
  tuneSessionThreadId: (id: number) => `tune-${id}`,
  getChatMemory: mock(() => null),
}));
mock.module("../server/ws", () => ({ wsManager: { broadcastNotification } }));
mock.module("../server/ai/setup-engineer-context", () => ({
  buildAppliedChangesMarkdown: mock(() => ""),
  computeSessionSymptoms: mock(async () => []),
  computeSessionTrackConditions: mock(async () => null),
  formatTrackConditions: mock(() => ""),
  gameHasSetupFile: (gameId: string) => gameId !== "f1-2025",
  loadActiveTuningContext: mock(async () => fakeCtx),
}));
mock.module("../server/db/queries", () => ({
  setLapTuningExcluded: mock(async () => {}),
  getLapById: mock(async () => null),
  getLapsForTuningSession: mock(async () => []),
}));
mock.module("../server/db/tuning-action-queries", () => ({ recordAction }));
mock.module("../server/tuning-undo", () => ({ undoLastAction: mock(async () => ({ ok: true })) }));
mock.module("../server/ai/consult-lap-analyst", () => ({ consultLapAnalystForSession: mock(async () => ({ ok: true, text: "" })) }));
mock.module("../server/ai/clean-lap-aggregate", () => ({ loadCleanLapAggregate: mock(async () => null) }));
mock.module("../server/comparison", () => ({ compareLaps: mock(() => ({})) }));

const { setupEngineerTools } = await import("../mastra/tools/setup-engineer");

const requestContext = { get: (k: string) => ({ gameId: "acc", sessionId: 61 } as any)[k] };

describe("apply_changes — no-op guard when every change is skipped", () => {
  test("returns ok:false with skipped reasons and creates NO version", async () => {
    writeAppliedSetup.mockClear();
    createTuningTest.mockClear();
    setSessionHead.mockClear();

    const result: any = await setupEngineerTools.applyChangesTool.execute(
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

describe("SETUP_ENGINEER_INSTRUCTIONS — prompt mandates", () => {
  test("mandates consult_lap_analyst before the first recommendation and refuses on unknown setup values", async () => {
    mock.module("../server/settings", () => ({ loadSettings: mock(() => ({ ai: {} })) }));
    mock.module("../mastra/model", () => ({ getMastraModelId: mock(() => "fake/model") }));
    const { SETUP_ENGINEER_INSTRUCTIONS } = await import("../mastra/agents/setup-engineer");

    // 1. First-recommendation gate on the lap analyst.
    expect(SETUP_ENGINEER_INSTRUCTIONS).toMatch(/MUST call \\?`consult_lap_analyst\\?` (?:once )?before (?:making |giving )?(?:your|the) FIRST setup recommendation/i);
    // 2. None-valued knobs are untunable but must not block tuning the rest;
    //    only a fully unknown setup is a hard stop.
    expect(SETUP_ENGINEER_INSTRUCTIONS).toMatch(/value None.*never recommend or apply changes to them/i);
    expect(SETUP_ENGINEER_INSTRUCTIONS).toMatch(/ALL current setup values are unknown.*unreadable/i);
  });
});
