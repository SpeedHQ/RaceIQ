import { describe, test, expect } from "bun:test";
import { parseLapTime } from "../../client/src/components/tune/browser/parseLapTime";

describe("parseLapTime", () => {
  test("parses M:SS.m and normalises", () => {
    const r = parseLapTime("Tuned for Nurb GP - 1:54.6");
    expect(r?.seconds).toBeCloseTo(114.6, 3);
    expect(r?.raw).toBe("1:54.6");
    expect(r?.track).toBe("Nürburgring");
  });
  test("parses leading-zero MM:SS.mmm", () => {
    const r = parseLapTime("Springs set at 5% fuel 01:54.493 Nurb GP Rivals");
    expect(r?.seconds).toBeCloseTo(114.493, 3);
    expect(r?.track).toBe("Nürburgring");
  });
  test("parses M:SS with le mans track", () => {
    const r = parseLapTime("easy drive R8 update Got 3:48 le mans");
    expect(r?.seconds).toBe(228);
    expect(r?.track).toBe("Le Mans");
  });
  test("no time → null", () => {
    expect(parseLapTime("just a balanced daily setup")).toBeNull();
    expect(parseLapTime("")).toBeNull();
    expect(parseLapTime(undefined)).toBeNull();
  });
  test("ignores non-time numbers like 5% fuel", () => {
    expect(parseLapTime("Springs set at 100% fuel. Updated 06/07/25.")).toBeNull();
  });
});
