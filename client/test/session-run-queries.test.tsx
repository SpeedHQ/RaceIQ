import { describe, expect, test } from "bun:test";

import { queryKeys } from "../src/hooks/query-keys";

const runId = `session-run:sha256:${"a".repeat(64)}`;

describe("session run query keys", () => {
  test("keeps session, driver, and run detail surfaces independent", () => {
    expect(queryKeys.sessionRuns(42, { runKind: "tire" })).not.toEqual(
      queryKeys.sessionRuns(42, { runKind: "pace" }),
    );
    expect(queryKeys.driverStints("driver-1")).not.toEqual(
      queryKeys.sessionRuns(42),
    );
    expect(queryKeys.sessionRunLaps(runId)).not.toEqual(
      queryKeys.sessionRunEvidence(runId),
    );
    expect(queryKeys.sessionRunEvidence(runId)).not.toEqual(
      queryKeys.comparableSessionRuns(runId),
    );
  });
});
