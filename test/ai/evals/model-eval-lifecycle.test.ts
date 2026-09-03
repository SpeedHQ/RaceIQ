import { describe, expect, test } from "bun:test";
import { candidateLifecycleCommands } from "../../../scripts/quality/model-eval-lifecycle";

describe("model evaluation lifecycle", () => {
  test("keeps only active candidate loaded", () => {
    expect(candidateLifecycleCommands(["bonsai", "qwen", "gemma"], "qwen")).toEqual([
      ["lms", "unload", "bonsai"],
      ["lms", "unload", "gemma"],
      ["lms", "load", "qwen", "--context-length", "131072", "--parallel", "4", "--yes"],
    ]);
  });
});
