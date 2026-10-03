import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getParaglideBuildKey } from "@raceiq/tooling/dev/paraglide-build";
import { computeParaglideInputHash } from "@raceiq/tooling/dev/paraglide-cache";

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

  test("build key tracks locale, project, lockfile, and installed compiler inputs", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "paraglide-key-"));
    const clientRoot = join(temporaryRoot, "client");
    try {
      await mkdir(join(clientRoot, "messages"), { recursive: true });
      await mkdir(join(clientRoot, "project.inlang"), { recursive: true });
      await mkdir(join(clientRoot, "node_modules/@inlang/paraglide-js"), { recursive: true });
      await writeFile(join(clientRoot, "messages/en.json"), "{\"hello\":\"Hello\"}");
      await writeFile(join(clientRoot, "project.inlang/settings.json"), "{\"modules\":[\"module-v1\"]}");
      await writeFile(join(clientRoot, "package.json"), "{\"dependencies\":{\"@inlang/paraglide-js\":\"2.25.4\"}}");
      await writeFile(join(temporaryRoot, "bun.lock"), "lock-v1");
      await writeFile(join(clientRoot, "node_modules/@inlang/paraglide-js/package.json"), "{\"version\":\"2.25.4\"}");

      const initial = await getParaglideBuildKey(clientRoot);
      await writeFile(join(clientRoot, "messages/en.json"), "{\"hello\":\"Hi\"}");
      const localeChanged = await getParaglideBuildKey(clientRoot);
      expect(localeChanged).not.toBe(initial);

      await writeFile(join(clientRoot, "messages/en.json"), "{\"hello\":\"Hello\"}");
      await writeFile(join(clientRoot, "project.inlang/settings.json"), "{\"modules\":[\"module-v2\"]}");
      const settingsChanged = await getParaglideBuildKey(clientRoot);
      expect(settingsChanged).not.toBe(initial);

      await writeFile(join(clientRoot, "project.inlang/settings.json"), "{\"modules\":[\"module-v1\"]}");
      await writeFile(join(temporaryRoot, "bun.lock"), "lock-v2");
      const lockChanged = await getParaglideBuildKey(clientRoot);
      expect(lockChanged).not.toBe(initial);

      await writeFile(join(temporaryRoot, "bun.lock"), "lock-v1");
      await writeFile(join(clientRoot, "node_modules/@inlang/paraglide-js/package.json"), "{\"version\":\"2.25.5\"}");
      expect(await getParaglideBuildKey(clientRoot)).not.toBe(initial);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
