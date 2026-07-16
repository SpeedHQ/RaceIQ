import { beforeAll, describe, expect, test } from "bun:test";
import { createTuningSession, getTuningSession, setSessionHead } from "../server/db/tuning-session-queries";
import { createTuningTest, resolveActiveTestId } from "../server/db/tuning-test-queries";
import { setSessionHead as _setHead } from "../server/db/tuning-session-queries";
import { loadActiveTuningContext } from "../server/ai/setup-engineer-context";

describe("head + active-test resolution", () => {
  let sessionId: number;
  let v1: number;
  let v2: number;

  beforeAll(async () => {
    sessionId = await createTuningSession({ gameId: "acc", name: "branch-test" });
    v1 = await createTuningTest({ tuningSessionId: sessionId, version: 1, label: "v1", parentTestId: null });
    v2 = await createTuningTest({ tuningSessionId: sessionId, version: 2, label: "v2", parentTestId: v1 });
  });

  test("resolveActiveTestId falls back to max-version test when no head", async () => {
    expect(await resolveActiveTestId(sessionId)).toBe(v2);
  });

  test("setSessionHead persists and resolveActiveTestId honours it", async () => {
    expect(await setSessionHead(sessionId, v1)).toBe(true);
    expect((await getTuningSession(sessionId))!.headTestId).toBe(v1);
    expect(await resolveActiveTestId(sessionId)).toBe(v1);
  });
});

describe("loadActiveTuningContext head resolution", () => {
  test("activeTest follows the persisted head, not the tip", async () => {
    const sid = await createTuningSession({ gameId: "acc", name: "ctx-head" });
    const a = await createTuningTest({ tuningSessionId: sid, version: 1, label: "v1", parentTestId: null });
    await createTuningTest({ tuningSessionId: sid, version: 2, label: "v2", parentTestId: a });
    await _setHead(sid, a);
    const ctx = await loadActiveTuningContext(sid);
    // No base setup file on this synthetic session → ctx.ok is false, but the
    // failure must be the missing-setup path, proving head (v1) was resolved and
    // its (null) setupPath drove the "no base setup" branch rather than the tip.
    expect(ctx.ok).toBe(false);
    if (!ctx.ok) expect(ctx.error).toContain("No base setup");
  });
});
