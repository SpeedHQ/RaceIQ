import { describe, test, expect } from "bun:test";
import { meterLevel, formatTokens } from "../../client/src/components/ai-chat/ChatPanel";

describe("meterLevel", () => {
  test("ok below 70%", () => { expect(meterLevel(10, 100)).toBe("ok"); });
  test("warn at 70%", () => { expect(meterLevel(70, 100)).toBe("warn"); });
  test("danger at 90%", () => { expect(meterLevel(90, 100)).toBe("danger"); });
  test("limit 0 is ok (avoid div by zero)", () => { expect(meterLevel(5, 0)).toBe("ok"); });
});

describe("formatTokens", () => {
  test("thousands", () => { expect(formatTokens(24_100)).toBe("24.1k"); });
  test("millions", () => { expect(formatTokens(1_000_000)).toBe("1M"); });
  test("small", () => { expect(formatTokens(512)).toBe("512"); });
});
