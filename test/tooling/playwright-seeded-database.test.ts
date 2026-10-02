import { describe, expect, test } from "bun:test";
import { portableCapturePath } from "../../playwright/support/server/seeded-database";

describe("seeded database capture paths", () => {
  test("accepts LMU captures from Windows seed producers", () => {
    expect(portableCapturePath("sessions\\lmu\\spa.bin.gz")).toBe("sessions/lmu/spa.bin.gz");
    expect(portableCapturePath("sessions/lmu/spa.bin")).toBe("sessions/lmu/spa.bin");
  });

  test("rejects LMU paths outside the capture directory and uncombined parts", () => {
    for (const path of [
      "sessions/lmu/../../app.db.bin.gz",
      "/sessions/lmu/spa.bin.gz",
      "sessions/lmu/spa.bin.gz.part1",
    ]) {
      expect(() => portableCapturePath(path)).toThrow("Invalid seeded capture path");
    }
  });
});
