import { describe, expect, test } from "bun:test";

import { buildGoogleProviderOptions } from "../server/ai/google-provider-options";

describe("buildGoogleProviderOptions", () => {
  test("omits thinking config for non-thinking Gemma models", () => {
    const opts = buildGoogleProviderOptions("gemma-4-31b-it", {}, 4096);
    expect(opts).toEqual({
      responseMimeType: "application/json",
      responseSchema: {},
    });
  });

  test("includes thinking config for Gemini models", () => {
    const opts = buildGoogleProviderOptions("gemini-2.5-pro", {}, 2048);
    expect(opts).toEqual({
      thinkingConfig: { thinkingBudget: 2048, includeThoughts: false },
      responseMimeType: "application/json",
      responseSchema: {},
    });
  });
  test("omits thinking config when budget is None", () => {
    const opts = buildGoogleProviderOptions("gemini-2.5-pro", {}, null);
    expect(opts).toEqual({
      responseMimeType: "application/json",
      responseSchema: {},
    });
  });
});
