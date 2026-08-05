import { describe, expect, test } from "bun:test";
import { shouldStartTray } from "../../server/runtime/platform/tray";

describe("tray startup", () => {
  test("disables Windows tray when RACEIQ_DISABLE_TRAY is enabled", () => {
    expect(shouldStartTray("win32", { RACEIQ_DISABLE_TRAY: "1" })).toBe(false);
  });

  test("starts tray on Windows by default", () => {
    expect(shouldStartTray("win32", {})).toBe(true);
  });

  test("never starts tray on non-Windows platforms", () => {
    expect(shouldStartTray("darwin", {})).toBe(false);
  });
});
