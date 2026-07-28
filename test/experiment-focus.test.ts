import { describe, expect, test } from "bun:test";
import {
  createExperiment,
  getExperiment,
  listExperimentFocusEvents,
  setExperimentFocus,
  setSessionHead,
} from "../server/db/experiment-queries";
import { createExperimentVersion, getExperimentVersion } from "../server/db/experiment-version-queries";
import {
  focusForVersionKind,
  headlineMetricForVersionKind,
  versionKindForFocus,
} from "../shared/experiment-focus";

/**
 * Focus is a MODE the driver switches mid-session ("the balance is fixed, now
 * let's work on my braking"), not the type of the experiment.
 *
 * Note the deliberate vocabulary split, asserted below: the mode is 'car' /
 * 'driver', the arm is 'setup' / 'drill'. Naming both pairs the same way made
 * "setup" mean a mode, an arm and a knob edit at once.
 *
 * The load-bearing claim is the split between the two: `experiments.focus`
 * changes, `experiment_versions.kind` does not. If switching focus rewrote the
 * kind of arms already recorded, a session's history would silently become a
 * lie — v1–v3 would claim to have been drills when they were setup versions,
 * and the review screen would then judge them on the wrong metric.
 */

describe("focus ↔ arm kind mapping", () => {
  test("driver focus produces drills, car focus produces setup arms", () => {
    expect(versionKindForFocus("car")).toBe("setup");
    expect(versionKindForFocus("driver")).toBe("drill");
    // Round-trips, so a recorded arm can always be read back as the focus it
    // was created under.
    expect(focusForVersionKind(versionKindForFocus("driver"))).toBe("driver");
    expect(focusForVersionKind(versionKindForFocus("car"))).toBe("car");
  });

  test("each arm kind is judged on its own metric", () => {
    expect(headlineMetricForVersionKind("setup")).toBe("best_lap");
    // The whole point of a drill can be a smaller spread at the same best lap.
    expect(headlineMetricForVersionKind("drill")).toBe("consistency");
  });
});

describe("experiments.focus", () => {
  test("defaults to car, which is what every pre-focus experiment was doing", async () => {
    const id = await createExperiment({ gameId: "acc", name: "focus-default" });
    expect((await getExperiment(id))!.focus).toBe("car");
  });

  test("an experiment can open on driver focus", async () => {
    const id = await createExperiment({ gameId: "acc", name: "focus-open-driver", focus: "driver" });
    expect((await getExperiment(id))!.focus).toBe("driver");
  });

  test("switching focus changes the next arm's kind and leaves earlier arms alone", async () => {
    const id = await createExperiment({ gameId: "acc", name: "focus-switch" });
    const v1 = await createExperimentVersion({ experimentId: id, version: 1, label: "v1" });
    const v2 = await createExperimentVersion({ experimentId: id, version: 2, label: "v2", parentVersionId: v1 });
    expect((await getExperimentVersion(v1))!.kind).toBe("setup");
    expect((await getExperimentVersion(v2))!.kind).toBe("setup");

    await setExperimentFocus(id, "driver");
    const v3 = await createExperimentVersion({ experimentId: id, version: 3, label: "v3", parentVersionId: v2 });
    expect((await getExperimentVersion(v3))!.kind).toBe("drill");

    // The claim that matters: history is not rewritten.
    expect((await getExperimentVersion(v1))!.kind).toBe("setup");
    expect((await getExperimentVersion(v2))!.kind).toBe("setup");

    // And switching back resumes setup arms — focus is a mode, not a one-way door.
    await setExperimentFocus(id, "car");
    const v4 = await createExperimentVersion({ experimentId: id, version: 4, label: "v4", parentVersionId: v3 });
    expect((await getExperimentVersion(v4))!.kind).toBe("setup");
    expect((await getExperimentVersion(v3))!.kind).toBe("drill");
  });

  test("an explicit kind overrides the focus (v1 base is always a setup arm)", async () => {
    const id = await createExperiment({ gameId: "acc", name: "focus-explicit-kind", focus: "driver" });
    const base = await createExperimentVersion({ experimentId: id, version: 1, label: "v1", kind: "setup" });
    expect((await getExperimentVersion(base))!.kind).toBe("setup");
  });
});

describe("focus ledger", () => {
  test("opens with the experiment's starting focus", async () => {
    const id = await createExperiment({ gameId: "acc", name: "ledger-open", focus: "driver" });
    const events = await listExperimentFocusEvents(id);
    expect(events.length).toBe(1);
    expect(events[0].focus).toBe("driver");
  });

  test("records each switch in order, with the head version it happened at", async () => {
    const id = await createExperiment({ gameId: "acc", name: "ledger-switches" });
    const v1 = await createExperimentVersion({ experimentId: id, version: 1, label: "v1" });
    await setSessionHead(id, v1);

    await setExperimentFocus(id, "driver", { note: "balance is fine now, my braking isn't" });
    await setExperimentFocus(id, "car");

    const events = await listExperimentFocusEvents(id);
    expect(events.map((e) => e.focus)).toEqual(["car", "driver", "car"]);
    // The era's starting point in the version tree, so the switch can be marked
    // on the node the driver was sitting on.
    expect(events[1].fromVersionId).toBe(v1);
    expect(events[1].note).toBe("balance is fine now, my braking isn't");
    // The driver's reason is recorded only when they gave one — never invented.
    expect(events[2].note).toBeNull();
  });

  test("re-selecting the focus already active is a no-op, not a ledger entry", async () => {
    const id = await createExperiment({ gameId: "acc", name: "ledger-noop" });
    expect(await setExperimentFocus(id, "car")).toBeNull();
    expect((await listExperimentFocusEvents(id)).length).toBe(1);
    // Still succeeds in the sense that matters: the desired state holds.
    expect((await getExperiment(id))!.focus).toBe("car");
  });

  test("switching focus on a missing experiment reports null rather than throwing", async () => {
    expect(await setExperimentFocus(999_999, "driver")).toBeNull();
  });
});
