import { describe, expect, test } from "bun:test";

import { queryKeys } from "../src/hooks/query-keys";

const runId = `session-run:sha256:${"a".repeat(64)}`;

describe("session run query keys", () => {
  test("keeps game-scoped session runs, driver, and run detail surfaces independent", () => {
    const tireRuns = queryKeys.sessionRuns(42, "acc", { runKind: "tire" });
    expect(tireRuns).not.toEqual(
      queryKeys.sessionRuns(42, "acc", { runKind: "pace" }),
    );
    expect(tireRuns).not.toEqual(
      queryKeys.sessionRuns(42, "iracing", { runKind: "tire" }),
    );
    expect(queryKeys.driverStints("driver-1")).not.toEqual(
      queryKeys.sessionRuns(42, "acc"),
    );
    expect(queryKeys.sessionRunLaps(runId)).not.toEqual(
      queryKeys.sessionRunEvidence(runId),
    );
    expect(queryKeys.sessionRunEvidence(runId)).not.toEqual(
      queryKeys.comparableSessionRuns(runId),
    );
  });
});
