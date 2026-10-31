import { expect, test } from "bun:test";
import { formatAnalysisUsage } from "client/src/components/ai/analysis-usage";

test("unknown analysis metrics are unavailable rather than zero-dollar claims", () => {
  expect(formatAnalysisUsage({ inputTokens: null, outputTokens: 0, costUsd: null, durationMs: null, model: "test" }, "en", "Unknown")).toBe("Unknown↓ 0↑ Unknown Unknown");
});

test("reported zero measurements retain their existing display", () => {
  expect(formatAnalysisUsage({ inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, model: "test" }, "en", "Unknown")).toBe("0↓ 0↑ $0.0000 0.0s");
});

test("known usage keeps localized counts and unreported cost uses supplied translation", () => {
  expect(formatAnalysisUsage({ inputTokens: 12630, outputTokens: 1731, costUsd: null, durationMs: 39426, model: "test" }, "de", "Unbekannt")).toBe("12.630↓ 1.731↑ Unbekannt 39.4s");
});
