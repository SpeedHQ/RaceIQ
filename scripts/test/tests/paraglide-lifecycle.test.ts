import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");

test.skipIf(process.platform === "win32")("watcher exits on POSIX signals, interrupted compilation, and parent loss", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "paraglide-lifecycle-"));
  const children: Bun.Subprocess[] = [];
  let orphanPid: number | undefined;
  // Real subprocess exit and POSIX reparenting cannot use fake timers; this only bounds failures.
  const deadline = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    if (orphanPid) { try { process.kill(orphanPid, "SIGKILL"); } catch {} }
  }, 20_000);
  try {
    await mkdir(join(fixture, "scripts/dev"), { recursive: true });
    await mkdir(join(fixture, "client/messages"), { recursive: true });
    await mkdir(join(fixture, "client/project.inlang"), { recursive: true });
    for (const file of ["paraglide-dev.ts", "paraglide-cache.ts", "paraglide-declarations.ts"]) {
      await copyFile(join(root, "scripts/dev", file), join(fixture, "scripts/dev", file));
    }
    await copyFile(join(root, "package.json"), join(fixture, "package.json"));
    await symlink(join(root, "node_modules"), join(fixture, "node_modules"), "junction");
    await symlink(join(root, "client/node_modules"), join(fixture, "client/node_modules"), "junction");
    await writeFile(join(fixture, "client/package.json"), '{"type":"module"}');
    // No remote plugins: lifecycle checks must run offline.
    await writeFile(join(fixture, "client/project.inlang/settings.json"), JSON.stringify({
      baseLocale: "en", locales: ["en", "de"], modules: [],
    }));
    for (const locale of ["en", "de"]) await writeFile(join(fixture, "client/messages", `${locale}.json`), "{}");

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const watcher = Bun.spawn(["bun", "scripts/dev/paraglide-dev.ts"], {
        cwd: fixture, stdout: "pipe", stderr: "inherit",
      });
      children.push(watcher);
      const reader = watcher.stdout.getReader();
      let output = "";
      while (!output.includes("Watching translation messages")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Watcher exited before readiness: ${output}`);
        output += new TextDecoder().decode(chunk.value);
      }
      reader.releaseLock();
      watcher.kill(signal);
      expect(await watcher.exited).toBe(0);
    }

    const parent = Bun.spawn(["bun", "-e", `
const watcher = Bun.spawn(["bun", "scripts/dev/paraglide-dev.ts"], { stdout: "inherit", stderr: "inherit" });
console.log("Watcher PID:", watcher.pid);
setInterval(() => {}, 1000);
`], { cwd: fixture, stdout: "pipe", stderr: "inherit" });
    children.push(parent);
    const reader = parent.stdout.getReader();
    let output = "";
    while (!output.includes("Watching translation messages")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Parent exited before watcher readiness: ${output}`);
      output += new TextDecoder().decode(chunk.value);
    }
    orphanPid = Number(output.match(/Watcher PID: (\d+)/)?.[1]);
    expect(orphanPid).toBeGreaterThan(0);
    parent.kill("SIGKILL");
    await parent.exited;
    // The watcher inherits this pipe. EOF proves it exited after losing its parent.
    expect((await reader.read()).done).toBe(true);
    orphanPid = undefined;
    reader.releaseLock();

    await rm(join(fixture, "client/project.inlang/.cache/raceiq-paraglide-dev.json"));
    const compiling = Bun.spawn(["bun", "scripts/dev/paraglide-dev.ts", "--once"], {
      cwd: fixture, stdout: "pipe", stderr: "inherit",
      env: { ...process.env, NODE_ENV: "development" },
    });
    children.push(compiling);
    const compilingReader = compiling.stdout.getReader();
    let compilingOutput = "";
    while (!compilingOutput.includes("[paraglide-js] Compiling")) {
      const chunk = await compilingReader.read();
      if (chunk.done) throw new Error(`Compiler exited before startup: ${compilingOutput}`);
      compilingOutput += new TextDecoder().decode(chunk.value);
    }
    compilingReader.releaseLock();
    compiling.kill("SIGTERM");
    expect(await compiling.exited).toBe(0);
    expect(await Bun.file(join(fixture, "client/project.inlang/.cache/raceiq-paraglide-dev.json")).exists()).toBe(false);
  } finally {
    clearTimeout(deadline);
    for (const child of children) child.kill("SIGKILL");
    if (orphanPid) { try { process.kill(orphanPid, "SIGKILL"); } catch {} }
    await Promise.all(children.map((child) => child.exited));
    await rm(fixture, { recursive: true, force: true });
  }
}, 30_000);
