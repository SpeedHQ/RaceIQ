import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("affected E2Es retain known ownership and conservatively include unknown or unavailable history", () => {
  const root = mkdtempSync(resolve(tmpdir(), "raceiq-e2e-selection-"));
  let diagnostics = "";
  const run = (args: string[], env: Record<string, string> = {}) => {
    const child = Bun.spawnSync(args, {
      cwd: root,
      env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    diagnostics = child.stderr.toString();
    expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0);
    return child.stdout.toString();
  };
  const commit = (message: string) => {
    run(["git", "add", "."]);
    run(["git", "-c", "user.name=RaceIQ fixture", "-c", "user.email=fixture@invalid", "commit", "-m", message]);
    return run(["git", "rev-parse", "HEAD"]).trim();
  };
  try {
    mkdirSync(resolve(root, "scripts/test"), { recursive: true });
    for (const file of ["run-turbo.ts", "owners.ts"]) {
      copyFileSync(resolve(import.meta.dir, "..", file), resolve(root, "scripts/test", file));
    }
    writeFileSync(resolve(root, "package.json"), JSON.stringify({
      name: "selection-fixture", private: true, packageManager: `bun@${Bun.version}`, workspaces: ["packages/*"],
    }));
    writeFileSync(resolve(root, "turbo.json"), JSON.stringify({
      tasks: { "e2e:impact": { cache: false }, "test:e2e": { dependsOn: ["e2e:impact"], cache: false } },
    }));
    writeFileSync(resolve(root, ".gitignore"), "node_modules/\n.turbo/\nAGENTS.md\n");
    for (const name of ["one", "two"]) {
      mkdirSync(resolve(root, "packages", name), { recursive: true });
      writeFileSync(resolve(root, "packages", name, "package.json"), JSON.stringify({
        name: `@fixture/${name}`, scripts: { "e2e:impact": "bun --version", "test:e2e": "bun --version" },
      }));
      writeFileSync(resolve(root, "packages", name, "ui.ts"), "export const value = 1;\n");
    }
    run([process.execPath, "install", "--lockfile-only", "--ignore-scripts"]);
    mkdirSync(resolve(root, "node_modules"), { recursive: true });
    symlinkSync(resolve(import.meta.dir, "../../../node_modules/turbo"), resolve(root, "node_modules/turbo"), "junction");
    run(["git", "init", "--initial-branch=main"]);
    const base = commit("Baseline");
    const selected = (head: string, baseRef = base, affected = true) => {
      const output = run([
        process.execPath, "scripts/test/run-turbo.ts", "e2e:impact", "test:e2e",
        ...(affected ? ["--affected"] : []), "--filter=@fixture/*", "--dry=json",
      ], { TURBO_SCM_BASE: baseRef, TURBO_SCM_HEAD: head });
      const result = JSON.parse(output) as { tasks: { taskId: string }[] };
      return result.tasks.map(({ taskId }) => taskId).filter((id) => id.endsWith("#test:e2e")).sort();
    };
    expect(selected(base)).toEqual([]);
    writeFileSync(resolve(root, "packages/one/ui.ts"), "export const value = 2;\n");
    const known = commit("Known feature change");
    expect(selected(known), diagnostics).toEqual(["@fixture/one#test:e2e"]);

    // Untracked and committed paths outside declared workspace ownership both need full coverage.
    writeFileSync(resolve(root, "unclassified.txt"), "An unclassified application input.\n");
    const full = ["@fixture/one#test:e2e", "@fixture/two#test:e2e"];
    expect(selected(known)).toEqual(full);
    const unknown = commit("Unclassified input");
    expect(selected(unknown)).toEqual(full);

    // A tracked deletion must not disappear merely because its owner cannot be resolved anymore.
    rmSync(resolve(root, "unclassified.txt"));
    expect(selected(unknown, unknown)).toEqual(full);
    run(["git", "add", "-u"]);
    expect(selected(unknown, unknown)).toEqual(full);
    expect(selected(unknown, "missing-history")).toEqual(full);
    expect(selected(unknown, base, false)).toEqual(full);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
