import { afterEach, expect, test } from "bun:test";
import { classificationMigrationActions as actions, classificationMigrationStore as store } from "../src/stores/classification-migration";
import type { ClassificationMigrationStatus } from "@raceiq/shared/racing/laps/classification-migration";

function status(revision: number, phase: ClassificationMigrationStatus["status"] = "running"): ClassificationMigrationStatus {
  return { version: 1, revision, status: phase, total: 8, pending: 0, running: 0, completed: 7, limited: 1, failed: 0, aggregatesPending: phase === "running" };
}
afterEach(() => store.setState({ status: null, recordings: [], error: null, dismissedRevision: null, retrying: [] }));

test("dismissed active classification stays hidden through summary refresh and completion", () => {
  actions.applyStatus(status(10));
  actions.dismiss(10);
  actions.applyStatus(status(11));
  expect(store.get().dismissedRevision).toBe(11);
  expect(store.get().status?.aggregatesPending).toBe(true);
  actions.applyStatus(status(12, "complete"));
  expect(store.get().dismissedRevision).toBe(12);
  expect(store.get().status?.status).toBe("complete");
  actions.applyStatus(status(13));
  expect(store.get().dismissedRevision).not.toBe(13);
  actions.applyStatus(status(14));
  expect(store.get().dismissedRevision).not.toBe(14);
});

test("stale classification responses cannot reopen a dismissed notice", () => {
  actions.applyStatus(status(20));
  actions.dismiss(20);
  actions.applyStatus(status(19));
  expect(store.get().status?.revision).toBe(20);
  expect(store.get().dismissedRevision).toBe(20);
});
