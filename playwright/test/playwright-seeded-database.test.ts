import { describe, expect, test } from "bun:test";
import { portableCapturePath } from "../support/server/seeded-database";

describe("seeded database capture paths", () => {
  test("accepts LMU captures from Windows seed producers", () => {
    expect(portableCapturePath("sessions\\lmu\\spa.bin.gz")).toBe("sessions/lmu/spa.bin.gz");
    expect(portableCapturePath("sessions/lmu/spa.bin")).toBe("sessions/lmu/spa.bin");
  });

  test.each([
    ["sessions\\fm-2023\\own\\capture.bin", "sessions/fm-2023/own/capture.bin"],
    ["sessions\\lmu\\others\\spa.bin.gz", "sessions/lmu/others/spa.bin.gz"],
    ["sessions\\iracing\\own\\navarra.ibt", "sessions/iracing/own/navarra.ibt"],
    ["sessions/iracing/others/navarra.ibt", "sessions/iracing/others/navarra.ibt"],
  ])("accepts organized capture %s", (input, expected) => {
    expect(portableCapturePath(input)).toBe(expected);
  });

  test("rejects LMU paths outside the capture directory and uncombined parts", () => {
    for (const path of [
      "sessions/lmu/../../app.db.bin.gz",
      "/sessions/lmu/spa.bin.gz",
      "sessions/lmu/spa.bin.gz.part1",
      "sessions/lmu/own/../../app.db.bin.gz",
      "sessions/lmu/unknown/spa.bin",
      "sessions/lmu/own/nested/spa.bin",
      "sessions/iracing/own/../../navarra.ibt",
      "sessions/iracing/own/nested/navarra.ibt",
      "sessions/acc/own/navarra.ibt",
    ]) {
      expect(() => portableCapturePath(path)).toThrow("Invalid seeded capture path");
    }
  });
});
