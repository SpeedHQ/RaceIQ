import { describe, expect, test } from "bun:test";
import { RequestContext } from "@mastra/core/request-context";
import { noopObserve } from "@mastra/core/tools";
import {
  driverCoachTools,
  recordDrillOutputSchema,
  type RecordDrillInput,
  type RecordDrillResult,
} from "../../../mastra/tools/driver-coach";
import { createExperiment, getExperiment, setSessionHead } from "../../../server/db/experiment-queries";
import { createExperimentVersion, getExperimentVersion, listExperimentVersions } from "../../../server/db/experiment-version-queries";
import type { DrillChange } from "../../../shared/racing/experiments/types";

/**
 * `record_drill` — the driver coach's write path, and the reason a driving
 * experiment can produce arms at all.
 *
 * Everything the race engineer can write goes through `applyIntents` and a
 * setup-FILE write, so before this tool a driving-focus experiment could only
 * ever have hand-seeded arms. The claims worth pinning are that a drill is a
 * real version row with NO setup file behind it, that it refuses without the
 * driver's confirmation, and that it branches where it was told to.
 */

const tool = driverCoachTools.recordDrillTool;
if (!tool.execute) throw new Error("record_drill tool has no execute handler");
const executeDrill = tool.execute;

async function runDrill(
  input: RecordDrillInput,
  sessionId: number,
): Promise<RecordDrillResult> {
  return recordDrillOutputSchema.parse(
    await executeDrill(input, ctx(sessionId)),
  );
}

/** The route sets these per turn; tools read them instead of taking a sessionId
 *  argument (weak models kept dropping the arg). */
function ctx(sessionId: number) {
  const requestContext = new RequestContext();
  requestContext.set("gameId", "acc");
  requestContext.set("sessionId", sessionId);
  return { requestContext, observe: noopObserve };
}

const drill = {
  title: "Brake 10m later into T4",
  instruction: "Hold the brake to the 40m board instead of the 50m, then release progressively to the apex.",
  corners: ["T4"],
  reason: "T4 is the widest corner spread in the stint at 0.31s",
  driverConfirmed: true,
};

describe("record_drill", () => {
  test("records a drill arm with no setup file behind it", async () => {
    const id = await createExperiment({ gameId: "acc", name: "drill-basic", focus: "driver" });
    const res = await runDrill(drill, id);

    expect(res.ok).toBe(true);
    const versions = await listExperimentVersions(id);
    const created = versions.find((v) => v.label === res.label)!;
    expect(created.kind).toBe("drill");
    // The whole point: a drill changes the driver, so there is nothing to write
    // to disk and nothing to snapshot.
    expect(created.setupPath).toBeNull();
    expect(created.setupSnapshot).toBeNull();

    const changes = JSON.parse(created.appliedChanges!) as DrillChange[];
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("drill");
    expect(changes[0].title).toBe(drill.title);
    expect(changes[0].corners).toEqual(["T4"]);
  });

  test("refuses without the driver's confirmation, and writes nothing", async () => {
    const id = await createExperiment({ gameId: "acc", name: "drill-unconfirmed", focus: "driver" });
    const before = (await listExperimentVersions(id)).length;

    const res = await runDrill({ ...drill, driverConfirmed: false }, id);

    expect(res.ok).toBe(false);
    expect(res.error).toContain("not confirmed");
    // The guard must not create a phantom arm — the failure mode that made
    // apply_changes grow the same gate.
    expect((await listExperimentVersions(id)).length).toBe(before);
  });

  test("advances the head to the new drill", async () => {
    const id = await createExperiment({ gameId: "acc", name: "drill-head", focus: "driver" });
    const res = await runDrill(drill, id);
    const created = (await listExperimentVersions(id)).find((v) => v.label === res.label)!;
    expect((await getExperiment(id))!.headVersionId).toBe(created.id);
  });

  test("branches from an explicit target instead of the head", async () => {
    const id = await createExperiment({ gameId: "acc", name: "drill-target", focus: "driver" });
    const v1 = await createExperimentVersion({ experimentId: id, version: 1, label: "v1", kind: "setup" });
    const v2 = await createExperimentVersion({ experimentId: id, version: 2, label: "v2", parentVersionId: v1, kind: "setup" });
    await setSessionHead(id, v2);

    const res = await runDrill({ ...drill, target: "v1" }, id);
    expect(res.ok).toBe(true);
    const created = (await listExperimentVersions(id)).find((v) => v.label === res.label)!;
    expect(created.parentVersionId).toBe(v1);
    // v2 is untouched — targeting is a fork, not a move.
    expect((await getExperimentVersion(v2))!.parentVersionId).toBe(v1);
  });

  test("an unknown target is refused rather than silently falling back to the head", async () => {
    const id = await createExperiment({ gameId: "acc", name: "drill-bad-target", focus: "driver" });
    await createExperimentVersion({ experimentId: id, version: 1, label: "v1", kind: "setup" });
    const before = (await listExperimentVersions(id)).length;

    const res = await runDrill({ ...drill, target: "v99" }, id);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("v99");
    expect((await listExperimentVersions(id)).length).toBe(before);
  });

  test("records a drill even while the experiment sits on car focus", async () => {
    // The coach only runs under driver focus, but a driver can flip focus back
    // between the proposal and the confirmation. The tool records a drill by
    // definition, so it must not inherit the experiment's current focus.
    const id = await createExperiment({ gameId: "acc", name: "drill-focus-flip", focus: "car" });
    const res = await runDrill(drill, id);
    const created = (await listExperimentVersions(id)).find((v) => v.label === res.label)!;
    expect(created.kind).toBe("drill");
  });
});
