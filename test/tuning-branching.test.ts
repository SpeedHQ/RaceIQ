import { beforeAll, describe, expect, test } from "bun:test";
import { createTuningSession, getTuningSession, setSessionHead } from "../server/db/tuning-session-queries";
import { createTuningTest, resolveActiveTestId } from "../server/db/tuning-test-queries";

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
