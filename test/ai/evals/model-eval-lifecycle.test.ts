import { describe, expect, test } from "bun:test";
import { candidateLifecycleCommands } from "../../../scripts/quality/model-eval-lifecycle";

describe("model evaluation lifecycle", () => {
  test("keeps only active candidate loaded", () => {
    expect(candidateLifecycleCommands(["bonsai", "qwen", "gemma"], "qwen")).toEqual([
      ["lms", "unload", "--all"],
      ["lms", "load", "qwen", "--context-length", "131072", "--parallel", "1", "--yes"],
    ]);
  });
});
