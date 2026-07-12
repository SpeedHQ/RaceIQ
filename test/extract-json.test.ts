import { describe, expect, test } from "bun:test";

import { extractJson } from "../server/ai/extract-json";

describe("extractJson", () => {
  test("returns plain JSON unchanged", () => {
    const raw = '{"verdict":"ok"}';
    expect(extractJson(raw)).toBe(raw);
  });

  test("strips markdown code fences before parsing", () => {
    const raw = "```json\n{\"verdict\":\"ok\"}\n```";
    expect(extractJson(raw)).toBe('{"verdict":"ok"}');
  });

  test("throws when payload is not valid JSON", () => {
    expect(() => extractJson("```json\nnope\n```"))
      .toThrow(/JSON|Unexpected|Unrecognized token/i);
  });
});
