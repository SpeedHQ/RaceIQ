import { describe, expect, test } from "bun:test";
import {
  advanceReprocess,
  beginReprocess,
  canStartReprocess,
  completeReprocess,
  dismissReprocess,
  failReprocess,
  initialReprocessState,
  submitStaleSessionReprocess,
} from "../../client/src/lib/reprocess-state";

describe("stale-session reprocessing state", () => {
  test("moves from idle through progress to success", () => {
    const submitting = beginReprocess(initialReprocessState, 2);
    expect(submitting).toEqual({ status: "submitting", open: true, done: 0, total: 2 });

    const progressing = advanceReprocess(submitting);
    expect(progressing).toEqual({ status: "progressing", open: true, done: 1, total: 2 });

    expect(completeReprocess(progressing)).toEqual({ status: "success", open: true, done: 2, total: 2 });
  });

  test("prevents a second request while one is active", () => {
    const active = beginReprocess(initialReprocessState, 3);
    expect(canStartReprocess(active)).toBe(false);
    expect(beginReprocess(active, 99)).toBe(active);
  });

  test("keeps progress bounded by the expected total", () => {
    const active = beginReprocess(initialReprocessState, 1);
    expect(advanceReprocess(advanceReprocess(active))).toMatchObject({ status: "progressing", done: 1, total: 1 });
  });

  test("retains progress and total when a visible request fails", () => {
    const active = advanceReprocess(beginReprocess(initialReprocessState, 3));
    const failed = failReprocess(active, "Try again");
    expect(failed).toEqual({ status: "error", open: true, done: 1, total: 3, message: "Try again" });
    expect(canStartReprocess(failed)).toBe(true);
    expect(beginReprocess(failed, failed.status === "error" ? failed.total : 0)).toEqual({ status: "submitting", open: true, done: 0, total: 3 });
  });

  test("dismisses completed and failed dialogs back to idle", () => {
    const success = completeReprocess(beginReprocess(initialReprocessState, 1));
    const error = failReprocess(beginReprocess(initialReprocessState, 1), "No");
    expect(dismissReprocess(success)).toEqual(initialReprocessState);
    expect(dismissReprocess(error)).toEqual(initialReprocessState);
  });

  test("hides an active request without allowing a duplicate and settles silently", () => {
    const hidden = dismissReprocess(beginReprocess(initialReprocessState, 2));
    expect(hidden).toEqual({ status: "submitting", open: false, done: 0, total: 2 });
    expect(canStartReprocess(hidden)).toBe(false);
    expect(completeReprocess(hidden)).toEqual(initialReprocessState);
    expect(failReprocess(hidden, "No")).toEqual(initialReprocessState);
  });
});

describe("submitStaleSessionReprocess", () => {
  test("returns a validated success response", async () => {
    const result = await submitStaleSessionReprocess(async () => new Response(JSON.stringify({ reprocessed: 2, results: [] }), { status: 200 }));
    expect(result.reprocessed).toBe(2);
  });

  test("rejects non-success responses", async () => {
    expect(submitStaleSessionReprocess(async () => new Response("no", { status: 503 }))).rejects.toThrow("status 503");
  });

  test("propagates thrown request failures", async () => {
    expect(
      submitStaleSessionReprocess(async () => {
        throw new Error("network unavailable");
      }),
    ).rejects.toThrow("network unavailable");
  });

  test("rejects malformed success responses", async () => {
    expect(submitStaleSessionReprocess(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))).rejects.toThrow("invalid response");
  });
});
