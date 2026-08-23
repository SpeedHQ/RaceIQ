import { describe, expect, test } from "bun:test";

import {
  SessionRunsCompletedMessageSchema,
  SessionRunsReplacedMessageSchema,
} from "../../shared/racing/runs/contracts";
import {
  isComparableSessionRunQueryKey,
  queryKeys,
  sessionRunsUpdatedQueryKeys,
} from "../src/hooks/query-keys";

const runId = `session-run:sha256:${"a".repeat(64)}`;

describe("session run websocket invalidation", () => {
  test("targets session list, run pages, driver stints, and completed run details", () => {
    const message = SessionRunsCompletedMessageSchema.safeParse({
      type: "session-runs-completed",
      sessionId: 42,
      runs: [],
    });
    expect(message.success).toBe(true);
    expect(sessionRunsUpdatedQueryKeys(42, [runId])).toEqual([
      ["session-runs", 42],
      ["sessions"],
      ["driver-stints"],
      ["session-run-details", runId],
    ]);
    expect(sessionRunsUpdatedQueryKeys(42, [runId])).not.toContainEqual([
      "session-events",
      42,
    ]);
  });

  test("keeps run notifications game-agnostic and invalidates replacement page scopes", () => {
    expect(
      SessionRunsCompletedMessageSchema.safeParse({
        type: "session-runs-completed",
        sessionId: 42,
        runs: [],
        gameId: "acc",
      }).success,
    ).toBe(false);
    expect(
      SessionRunsReplacedMessageSchema.parse({
        type: "session-runs-replaced",
        sessionId: 42,
      }),
    ).toEqual({ type: "session-runs-replaced", sessionId: 42 });
    expect(
      SessionRunsReplacedMessageSchema.safeParse({
        type: "session-runs-replaced",
        sessionId: 42,
        gameId: "acc",
      }).success,
    ).toBe(false);
    expect(sessionRunsUpdatedQueryKeys(42)).toEqual([
      ["session-runs", 42],
      ["sessions"],
      ["driver-stints"],
    ]);
  });

  test("targets comparable caches and reconnect driver pages", () => {
    expect(
      isComparableSessionRunQueryKey(
        queryKeys.comparableSessionRuns(runId, { gameId: "acc" }),
      ),
    ).toBe(true);
    expect(
      isComparableSessionRunQueryKey(queryKeys.sessionRunLaps(runId)),
    ).toBe(false);
    expect(queryKeys.driverStintPages).toEqual(["driver-stints"]);
  });
});
