import { describe, expect, test } from "bun:test";
import {
  resolveRecordingGameId,
  resolveRecordingPath,
} from "../../server/routes/dev/recording-support";

describe("developer recording support", () => {
  test("resolves canonical committed fixture names", () => {
    expect(resolveRecordingGameId("fm-2023-2026-04-09T21-55-03-186Z")).toBe("fm-2023");
    expect(resolveRecordingGameId("f1-2025-2026-04-22T11-42-43-029Z")).toBe("f1-2025");
    expect(resolveRecordingGameId("acc-2026-04-23T16-42-16-158Z")).toBe("acc");
    expect(resolveRecordingGameId("session-ac-evo-mid-2026-04-21T20-24-34-810Z")).toBe("ac-evo");
    expect(resolveRecordingGameId("iracing-road-america-gt3")).toBe("iracing");
    expect(resolveRecordingGameId("unknown-recording")).toBeNull();
  });

  test("accepts committed gzip fixtures and rejects path traversal", () => {
    expect(resolveRecordingPath("iracing-road-america-gt3")).toMatchObject({ ok: true });
    expect(resolveRecordingPath("../settings")).toEqual({
      ok: false,
      error: "Invalid filename",
      status: 400,
    });
    expect(resolveRecordingPath("missing-recording")).toEqual({
      ok: false,
      error: "Recording not found",
      status: 404,
    });
  });
});
