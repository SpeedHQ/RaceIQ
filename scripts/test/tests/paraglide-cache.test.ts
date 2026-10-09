import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getParaglideBuildKey, syncParaglideOutput } from "../../dev/paraglide-build";
import { computeParaglideInputHash } from "../../dev/paraglide-cache";

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
  test("publishes a complete generated file set and removes obsolete modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "paraglide-publish-"));
    const source = join(root, "stage");
    const output = join(root, "output");
    try {
      await mkdir(join(source, "messages"), { recursive: true });
      await mkdir(join(output, "messages"), { recursive: true });
      await writeFile(join(source, "runtime.js"), "stable runtime");
      await writeFile(join(output, "runtime.js"), "stable runtime");
      await writeFile(join(source, "messages/new.js"), "new translation");
      await writeFile(join(source, "messages/new.d.ts"), "new declaration");
      await writeFile(join(output, "messages/old.js"), "obsolete translation");
      await syncParaglideOutput(source, output,
        { "runtime.js": "stable", "messages/new.js": "new", "messages/new.d.ts": "declaration" },
        { "runtime.js": "stable", "messages/old.js": "old" });
      expect(await readFile(join(output, "runtime.js"), "utf8")).toBe("stable runtime");
      expect(await readFile(join(output, "messages/new.js"), "utf8")).toBe("new translation");
      expect(await readFile(join(output, "messages/new.d.ts"), "utf8")).toBe("new declaration");
      expect(await Bun.file(join(output, "messages/old.js")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "win32")("publishes while a Windows reader denies delete sharing", async () => {
    const root = await mkdtemp(join(tmpdir(), "paraglide-locked-output-"));
    const source = join(root, "stage");
    const output = join(root, "output");
    await mkdir(source);
    await mkdir(output);
    await writeFile(join(source, "runtime.js"), "updated runtime");
    await writeFile(join(output, "runtime.js"), "previous runtime");
    const reader = Bun.spawn(["powershell", "-NoProfile", "-Command",
      "$file = [System.IO.File]::Open($env:PARAGLIDE_LOCK_FILE, 'Open', 'Read', 'ReadWrite'); try { [Console]::WriteLine('READY'); [Console]::ReadLine() | Out-Null } finally { $file.Dispose() }"],
      { env: { ...process.env, PARAGLIDE_LOCK_FILE: join(output, "runtime.js") }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      const stdout = reader.stdout.getReader();
      try {
        const ready = await stdout.read();
        expect(new TextDecoder().decode(ready.value)).toContain("READY");
      } finally {
        stdout.releaseLock();
      }
      await syncParaglideOutput(source, output, { "runtime.js": "updated" }, { "runtime.js": "previous" });
      expect(await readFile(join(output, "runtime.js"), "utf8")).toBe("updated runtime");
    } finally {
      reader.stdin.end();
      await reader.exited;
      await rm(root, { recursive: true, force: true });
    }
  });
});
