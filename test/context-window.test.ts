import { describe, test, expect } from "bun:test";
import { contextWindowFor } from "../shared/ai/context-window";

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
  test("unknown provider falls back to 32k", () => {
    expect(contextWindowFor("whoknows", "x")).toBe(32_000);
  });
  test("local falls back to 32k", () => {
    expect(contextWindowFor("local", "local-model")).toBe(32_000);
  });
});
