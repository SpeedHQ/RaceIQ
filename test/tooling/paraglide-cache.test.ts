import { describe, expect, test } from "bun:test";
import { computeParaglideInputHash } from "../../scripts/dev/paraglide-cache";

describe("Paraglide dev cache", () => {
  test("changes when translation input changes", async () => {
    const base = await computeParaglideInputHash([
      ["messages/en.json", "hello"],
      ["messages/de.json", "hallo"],
    ], "compiler-v1");
    const changed = await computeParaglideInputHash([
      ["messages/en.json", "hello"],
      ["messages/de.json", "guten tag"],
    ], "compiler-v1");

    expect(changed).not.toBe(base);
  });

  test("changes when compiler fingerprint changes", async () => {
    const first = await computeParaglideInputHash([["messages/en.json", "hello"]], "compiler-v1");
    const second = await computeParaglideInputHash([["messages/en.json", "hello"]], "compiler-v2");

    expect(second).not.toBe(first);
  });
});
