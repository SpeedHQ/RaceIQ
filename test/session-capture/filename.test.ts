import { expect, test } from "bun:test";
import { timestampForFilename } from "../../server/session-capture/filename";

test("capture timestamps are valid Windows filename components", () => {
  const timestamp = timestampForFilename(new Date("2026-08-30T12:34:56.789Z"));

  expect(timestamp).toBe("2026-08-30T12-34-56-789Z");
  expect(timestamp).not.toMatch(/[<>:"/\\|?*]/);
});
