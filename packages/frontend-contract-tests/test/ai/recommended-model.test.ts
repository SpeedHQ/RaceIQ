import { describe, expect, test } from "bun:test";

import { isRecommendedModel, recommendedFirst } from "client/src/components/settings/recommended-model";

describe("recommended Claude model", () => {
  test("matches Haiku 5.5 and its dated snapshots only", () => {
    expect(isRecommendedModel("claude-haiku-5-5")).toBe(true);
    expect(isRecommendedModel("claude-haiku-5-5-20260901")).toBe(true);
    expect(isRecommendedModel("claude-haiku-5-50")).toBe(false);
    expect(isRecommendedModel("claude-sonnet-5-5")).toBe(false);
    expect(isRecommendedModel("gpt-4o-mini")).toBe(false);
  });

  test("moves the recommended model to the top and keeps the rest in order", () => {
    const models = [{ id: "claude-opus-5-5" }, { id: "claude-sonnet-5-5" }, { id: "claude-haiku-5-5" }, { id: "claude-haiku-4-5" }];
    expect(recommendedFirst(models).map((model) => model.id)).toEqual([
      "claude-haiku-5-5",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-4-5",
    ]);
  });

  test("leaves lists without the recommended model unchanged", () => {
    const models = [{ id: "gemini-flash-latest" }, { id: "gemini-pro-latest" }];
    expect(recommendedFirst(models)).toEqual(models);
  });
});
