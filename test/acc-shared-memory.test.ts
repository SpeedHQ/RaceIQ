import { describe, test, expect } from "bun:test";
import { readWString } from "../server/games/acc/utils";

// We can't test actual shared memory without ACC running,
// but we can test the buffer reading utilities
describe("ACC shared memory utilities", () => {
  test("readWString extracts null-terminated UTF-16LE string from buffer", () => {
    // "Monza" in UTF-16LE
    const buf = Buffer.alloc(20);
    buf.write("Monza", 0, "utf16le");
    expect(readWString(buf, 0, 20)).toBe("Monza");
  });

  test("readWString handles empty string", () => {
    const buf = Buffer.alloc(20);
    expect(readWString(buf, 0, 20)).toBe("");
  });
});
