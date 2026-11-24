import { describe, test, expect } from "bun:test";
import { contextWindowFor } from "@raceiq/shared/integrations/ai/context-window";

describe("contextWindowFor", () => {
  test("gemini flash is 1M", () => {
    expect(contextWindowFor("gemini", "gemini-flash-latest")).toBe(1_000_000);
  });
  test("openai gpt-4o-mini is 128k", () => {
    expect(contextWindowFor("openai", "gpt-4o-mini")).toBe(128_000);
  });
  test("known ChatGPT subscription models use the published input limit", () => {
    expect(contextWindowFor("chatgpt-subscription", "gpt-6.2-sol")).toBe(922_000);
    expect(contextWindowFor("chatgpt-subscription", "gpt-6-luna")).toBe(922_000);
  });
  test("unknown ChatGPT subscription models do not inherit another model's limit", () => {
    expect(contextWindowFor("chatgpt-subscription", "gpt-7")).toBeUndefined();
  });
  test("anthropic claude is 200k", () => {
    expect(contextWindowFor("claude-cli", "sonnet")).toBe(200_000);
  });
  test("unknown provider is undefined (no meter, not a made-up limit)", () => {
    expect(contextWindowFor("whoknows", "x")).toBeUndefined();
  });
  test("local without a reported context length is undefined", () => {
    expect(contextWindowFor("openai-compatible", "local-model")).toBeUndefined();
  });
  test("local uses the context length reported by the local server", () => {
    expect(contextWindowFor("openai-compatible", "local-model", 8_192)).toBe(8_192);
  });
  test("local ignores a non-positive reported context length", () => {
    expect(contextWindowFor("openai-compatible", "local-model", 0)).toBeUndefined();
  });

});
