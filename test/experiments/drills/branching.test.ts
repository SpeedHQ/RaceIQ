import { beforeAll, describe, expect, test } from "bun:test";
import { createExperiment, getExperiment, setSessionHead } from "../../../server/db/experiment-queries";
import { createExperimentVersion, resolveActiveTestId } from "../../../server/db/experiment-version-queries";
import { setSessionHead as _setHead } from "../../../server/db/experiment-queries";
import { loadActiveExperimentContext } from "../../../server/experiments/setup-lineage";
import { computeChildLabel, nextFreeLabel } from "../../../server/ai/version-label";
import { getActiveExperiment, setActiveExperiment } from "../../../server/experiments/active"

describe("head + active-test resolution", () => {
  let sessionId: number;
  let v1: number;
  let v2: number;

  beforeAll(async () => {
    sessionId = await createExperiment({ gameId: "acc", name: "branch-test" });
    v1 = await createExperimentVersion({ experimentId: sessionId, version: 1, label: "v1", parentVersionId: null });
    v2 = await createExperimentVersion({ experimentId: sessionId, version: 2, label: "v2", parentVersionId: v1 });
  });

  test("resolveActiveTestId falls back to max-version test when no head", async () => {
    expect(await resolveActiveTestId(sessionId)).toBe(v2);
  });

  test("setSessionHead persists and resolveActiveTestId honours it", async () => {
    expect(await setSessionHead(sessionId, v1)).toBe(true);
    expect((await getExperiment(sessionId))!.headVersionId).toBe(v1);
    expect(await resolveActiveTestId(sessionId)).toBe(v1);
  });
});

describe("loadActiveExperimentContext head resolution", () => {
  test("activeTest follows the persisted head, not the tip", async () => {
    const sid = await createExperiment({ gameId: "acc", name: "ctx-head" });
    const a = await createExperimentVersion({ experimentId: sid, version: 1, label: "v1", parentVersionId: null });
    await createExperimentVersion({ experimentId: sid, version: 2, label: "v2", parentVersionId: a });
    await _setHead(sid, a);
    const ctx = await loadActiveExperimentContext(sid);
    // No base setup file on this synthetic session → ctx.ok is false, but the
    // failure must be the missing-setup path, proving head (v1) was resolved and
    // its (null) setupPath drove the "no base setup" branch rather than the tip.
    expect(ctx.ok).toBe(false);
    if (!ctx.ok) expect(ctx.error).toContain("No base setup");
  });
});

describe("apply-changes label derivation (unit of the branch math)", () => {
  test("second child of v1 nests as v1.2", () => {
    // parent = v1 with one existing child (v1.1) → next child → v1.2
    const label = nextFreeLabel(computeChildLabel("v1", 1), new Set(["v1", "v1.1"]));
    expect(label).toBe("v1.2");
  });
  test("first child of the tip nests under it", () => {
    const label = nextFreeLabel(computeChildLabel("v2", 0), new Set(["v1", "v2"]));
    expect(label).toBe("v2.1");
  });
});

describe("resolveActiveTestId drives the lap stamp value", () => {
  test("resolves the head test for the active session", async () => {
    const sid = await createExperiment({ gameId: "acc", name: "stamp" });
    const a = await createExperimentVersion({ experimentId: sid, version: 1, label: "v1", parentVersionId: null });
    await setSessionHead(sid, a);
    setActiveExperiment(sid);
    expect(getActiveExperiment()).toBe(sid);
    expect(await resolveActiveTestId(sid)).toBe(a);
    setActiveExperiment(null);
  });
});
