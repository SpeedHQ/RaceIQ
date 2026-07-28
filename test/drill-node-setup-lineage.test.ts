import { describe, expect, test } from "bun:test";
import { createExperiment, getExperiment, setSessionHead } from "../server/db/experiment-queries";
import { createExperimentVersion, listExperimentVersions } from "../server/db/experiment-version-queries";
import { resolveSetupPathForVersion } from "../server/ai/setup-engineer-context";

/**
 * A drill arm carries no setup: `setupPath` and `setupSnapshot` are both null by
 * design (that is the whole point of `kind: 'drill'`). But a drill node still
 * sits IN the version tree, as a child of whatever setup version was current
 * when it was recorded.
 *
 * So every reader of "what setup is the car on right now" has to walk PAST a
 * drill node to the nearest setup-bearing ancestor. Falling back to the
 * experiment's original base instead silently reverts the car to where it
 * started, discarding every setup change made along the way — and the driver is
 * never told, because a base setup is a perfectly valid-looking answer.
 *
 * This is reachable through ordinary use: work on the car, flip focus to driver,
 * record a drill, flip back and ask the engineer for a change.
 */
describe("setup lineage across a drill node", () => {
  test("resolves to the nearest setup ancestor, not the experiment base", async () => {
    const id = await createExperiment({
      gameId: "acc",
      name: "lineage",
      focus: "car",
      baseSetupPath: "base.json",
    });

    // v1: the base the experiment started from.
    const v1 = await createExperimentVersion({
      experimentId: id,
      version: 1,
      label: "v1",
      kind: "setup",
      setupPath: "base.json",
      setupSnapshot: null,
      parentVersionId: null,
      appliedChanges: null,
      notes: null,
      engine: "manual",
    });

    // v2: a real setup change. THIS is the car the driver is running.
    const v2 = await createExperimentVersion({
      experimentId: id,
      version: 2,
      label: "v2",
      kind: "setup",
      setupPath: "softer-arb.json",
      setupSnapshot: null,
      parentVersionId: v1,
      appliedChanges: JSON.stringify([{ kind: "setup", component: "rearARB", direction: "down" }]),
      notes: null,
      engine: "llm",
    });

    // v3: focus flips to the driver and a drill is recorded on top of v2.
    // The car has not changed — only what the driver is doing has.
    const v3 = await createExperimentVersion({
      experimentId: id,
      version: 3,
      label: "v3",
      kind: "drill",
      setupPath: null,
      setupSnapshot: null,
      parentVersionId: v2,
      appliedChanges: JSON.stringify([{ kind: "drill", title: "Brake later into T4" }]),
      notes: null,
      engine: "llm",
    });
    await setSessionHead(id, v3);

    // The driver flips back to the car. The engineer must work from v2's setup.
    const resolved = await resolveSetupPathForVersion(id, v3);

    expect(resolved).toBe("softer-arb.json");
    // The failure mode being guarded: silently reverting to the experiment base.
    expect(resolved).not.toBe("base.json");

    // Pin that this test is not vacuous — the previous expression
    // (`activeTest?.setupPath ?? session.baseSetupPath`) really did resolve to
    // the base setup here, discarding v2's change.
    const versions = await listExperimentVersions(id);
    const head = versions.find((v) => v.id === v3)!;
    const session = await getExperiment(id);
    const previousBehaviour = head.setupPath ?? session!.baseSetupPath ?? null;
    expect(previousBehaviour).toBe("base.json");
    expect(previousBehaviour).not.toBe(resolved);
  });

  test("a chain of drills still finds the setup underneath", async () => {
    const id = await createExperiment({
      gameId: "acc",
      name: "lineage-chain",
      focus: "driver",
      baseSetupPath: "base.json",
    });

    const v1 = await createExperimentVersion({
      experimentId: id, version: 1, label: "v1", kind: "setup",
      setupPath: "tuned.json", setupSnapshot: null, parentVersionId: null,
      appliedChanges: null, notes: null, engine: "manual",
    });
    let parent = v1;
    for (let i = 2; i <= 4; i++) {
      parent = await createExperimentVersion({
        experimentId: id, version: i, label: `v${i}`, kind: "drill",
        setupPath: null, setupSnapshot: null, parentVersionId: parent,
        appliedChanges: null, notes: null, engine: "llm",
      });
    }
    await setSessionHead(id, parent);

    expect(await resolveSetupPathForVersion(id, parent)).toBe("tuned.json");
  });

  test("falls back to the experiment base only when there is genuinely no setup ancestor", async () => {
    // A driving experiment that never had a setup arm at all: the base is the
    // honest answer here, because nothing has changed the car.
    const id = await createExperiment({
      gameId: "acc",
      name: "lineage-pure-driving",
      focus: "driver",
      baseSetupPath: "base.json",
    });
    const only = await createExperimentVersion({
      experimentId: id, version: 1, label: "v1", kind: "drill",
      setupPath: null, setupSnapshot: null, parentVersionId: null,
      appliedChanges: null, notes: null, engine: "llm",
    });
    await setSessionHead(id, only);

    expect(await resolveSetupPathForVersion(id, only)).toBe("base.json");
  });
});
