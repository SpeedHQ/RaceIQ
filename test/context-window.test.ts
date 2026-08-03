import { describe, test, expect } from "bun:test";
import { contextWindowFor } from "../shared/integrations/ai/context-window";

describe("contextWindowFor", () => {
  test("gemini flash is 1M", () => {
    expect(contextWindowFor("gemini", "gemini-flash-latest")).toBe(1_000_000);
  });
  test("openai gpt-4o-mini is 128k", () => {
    expect(contextWindowFor("openai", "gpt-4o-mini")).toBe(128_000);
  });
  test("anthropic claude is 200k", () => {
    expect(contextWindowFor("claude-cli", "sonnet")).toBe(200_000);
  });
  test("unknown provider is undefined (no meter, not a made-up limit)", () => {
    expect(contextWindowFor("whoknows", "x")).toBeUndefined();
  });
  test("local without a reported context length is undefined", () => {
    expect(contextWindowFor("local", "local-model")).toBeUndefined();
  });
  test("local uses the context length reported by the local server", () => {
    expect(contextWindowFor("local", "local-model", 8_192)).toBe(8_192);
  });
  test("local ignores a non-positive reported context length", () => {
    expect(contextWindowFor("local", "local-model", 0)).toBeUndefined();
  });
});
