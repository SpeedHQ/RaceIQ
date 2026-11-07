import { describe, expect, test } from "bun:test";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const selector = resolve(root, "scripts/ci/affected-verification.ts");

function run(...args: string[]) {
  return Bun.spawnSync(["bun", selector, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
}

function queryResult(items: unknown[]) {
  return JSON.stringify({ data: { affectedTasks: { length: items.length, items } } });
}

function impact(name: string, owner: string) {
  return { name, fullName: `${owner}#${name}`, package: { name: owner } };
}

function runWithQuery(output: string) {
  const directory = mkdtempSync(resolve(tmpdir(), "raceiq-selector-query-"));
  try {
    writeFileSync(resolve(directory, "git"), "#!/bin/sh\ncase \"$1\" in diff) printf 'docs/example.md\\0';; *) case \"$*\" in *base*) echo a;; *) echo b;; esac;; esac\n");
    writeFileSync(resolve(directory, "bunx"), "#!/bin/sh\nprintf '%s' \"$SELECTOR_QUERY\"\n");
    chmodSync(resolve(directory, "git"), 0o755);
    chmodSync(resolve(directory, "bunx"), 0o755);
    return Bun.spawnSync(["bun", selector, "--mode", "affected", "--base", "base", "--head", "head"], {
      cwd: root,
      env: { ...Bun.env, PATH: `${directory}:${Bun.env.PATH ?? ""}`, SELECTOR_QUERY: output },
      stdout: "pipe",
      stderr: "pipe",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("affected verification selector", () => {
  test("full mode preserves the browser and visual inventory", () => {
    const process = run("--mode", "full");
    expect(process.exitCode).toBe(0);
    const selection = JSON.parse(process.stdout.toString());
    expect(selection.mode).toBe("full");
    expect(selection.browserMatrix).toHaveLength(10);
    expect(selection.browserMatrix.filter((row: { serverSet: string }) => row.serverSet === "seeded")).toHaveLength(7);
    expect(selection.seedDatabase).toBe(true);
    expect(selection.nativeWebgpu).toBe(true);
    expect(selection.responsive).toBe(true);
    expect(selection.storybook).toBe(true);
  });

  test("full selection covers real Playwright discovery without record-demo", () => {
    const selection = JSON.parse(run("--mode", "full").stdout.toString());
    const projects = new Set<string>(selection.browserMatrix.flatMap((row: { projects: string[] }) => row.projects));
    if (selection.nativeWebgpu) projects.add("lap-replay-webgpu");
    const args = [...projects].map((project) => `--project=${project}`);
    const discovery = Bun.spawnSync(
      ["bunx", "--no-install", "playwright", "test", "--config=playwright/playwright.config.ts", "--list", "--reporter=json", ...args],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(discovery.exitCode).toBe(0);
    const report = JSON.parse(discovery.stdout.toString());
    const discovered = new Set<string>();
    function visit(suite: { suites?: unknown[]; specs?: { tests: { projectName: string }[] }[] }) {
      for (const spec of suite.specs ?? []) for (const item of spec.tests) discovered.add(item.projectName);
      for (const child of suite.suites ?? []) visit(child as typeof suite);
    }
    for (const suite of report.suites) visit(suite);
    expect(discovered).toEqual(new Set([...projects, "seeded-setup", "tunes-setup"]));
    expect(discovered.has("record-demo")).toBe(false);
  }, 120_000);

  test("missing and invalid ranges fall back to full with diagnostics", () => {
    for (const args of [["--mode", "affected"], ["--mode", "affected", "--base", "not-a-ref", "--head", "HEAD"], ["--mode", "affected", "--base", "HEAD", "--head", "HEAD"]]) {
      const process = run(...args);
      expect(process.exitCode).toBe(0);
      expect(JSON.parse(process.stdout.toString()).mode).toBe("full");
      expect(process.stderr.toString()).toContain("selecting full inventory");
    }
  });

  test("a failed Turbo query falls back to full instead of reporting no work", () => {
    const previous = Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD^"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(previous.exitCode).toBe(0);
    const directory = mkdtempSync(resolve(tmpdir(), "raceiq-turbo-failure-"));
    try {
      const executable = resolve(directory, "bunx");
      writeFileSync(executable, "#!/bin/sh\nprintf 'injected query failure\\n' >&2\nexit 1\n");
      chmodSync(executable, 0o755);
      const process = Bun.spawnSync(
        ["bun", selector, "--mode", "affected", "--base", previous.stdout.toString().trim(), "--head", "HEAD"],
        { cwd: root, env: { ...Bun.env, PATH: `${directory}:${Bun.env.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe" },
      );
      expect(process.exitCode).toBe(0);
      expect(JSON.parse(process.stdout.toString()).mode).toBe("full");
      expect(process.stderr.toString()).toContain("injected query failure");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("any browser impact selects the complete browser matrix", () => {
    for (const items of [
      [impact("e2e:impact", "@raceiq/tracks-catalogue")],
      [impact("browser:fresh:impact", "raceiq-e2e")],
      [impact("browser:tunes:impact", "raceiq-e2e")],
    ]) {
      const process = runWithQuery(queryResult(items));
      expect(process.exitCode).toBe(0);
      const selection = JSON.parse(process.stdout.toString());
      const full = JSON.parse(run("--mode", "full").stdout.toString());
      expect(selection.mode).toBe("affected");
      expect(selection.browserMatrix).toEqual(full.browserMatrix);
      expect(selection.seedDatabase).toBe(true);
      expect(selection.nativeWebgpu).toBe(true);
      expect(selection.responsive).toBe(false);
      expect(selection.storybook).toBe(false);
    }
  });

  test("a proven empty selection skips every category", () => {
    const process = runWithQuery(queryResult([]));
    expect(process.exitCode).toBe(0);
    const selection = JSON.parse(process.stdout.toString());
    expect(selection.mode).toBe("affected");
    expect(selection.browserMatrix).toHaveLength(0);
    expect(selection.seedDatabase || selection.nativeWebgpu || selection.responsive || selection.storybook).toBe(false);
  });
  test("visual impacts select only their complete categories", () => {
    for (const [task, responsive, storybook] of [
      ["visual:responsive:impact", true, false],
      ["visual:storybook:impact", false, true],
    ] as const) {
      const process = runWithQuery(queryResult([impact(task, "raceiq-e2e")]));
      expect(process.exitCode).toBe(0);
      const selection = JSON.parse(process.stdout.toString());
      expect(selection.mode).toBe("affected");
      expect(selection.browserMatrix).toEqual([]);
      expect(selection.seedDatabase || selection.nativeWebgpu).toBe(false);
      expect(selection.responsive).toBe(responsive);
      expect(selection.storybook).toBe(storybook);
    }
  });

  test("ignores inherited impact nodes without a consumer task", () => {
    const process = runWithQuery(queryResult([
      impact("e2e:impact", "@raceiq/analysis-core"),
      impact("e2e:impact", "@raceiq/tracks-catalogue"),
    ]));
    expect(process.exitCode).toBe(0);
    const selection = JSON.parse(process.stdout.toString());
    expect(selection.mode).toBe("affected");
    expect(selection.browserMatrix).toEqual(JSON.parse(run("--mode", "full").stdout.toString()).browserMatrix);
  });


  test("malformed output and unknown impact ownership fall back to full", () => {
    for (const output of [
      "not json",
      JSON.stringify({ data: { affectedTasks: { length: 1, items: [] } } }),
      queryResult([impact("e2e:impact", "@raceiq/not-a-workspace")]),
      queryResult([impact("unknown:impact", "raceiq-e2e")]),
    ]) {
      const process = runWithQuery(output);
      expect(process.exitCode).toBe(0);
      expect(JSON.parse(process.stdout.toString()).mode).toBe("full");
      expect(process.stderr.toString()).toContain("selecting full inventory");
    }
  });
  test("malformed or incomplete Turbo task inventories fail closed", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "raceiq-selector-inventory-"));
    try {
      writeFileSync(resolve(directory, "git"), "#!/bin/sh\ncase \"$1\" in diff) printf 'src/input.ts\\0';; *) case \"$*\" in *base*) echo a;; *) echo b;; esac;; esac\n");
      writeFileSync(resolve(directory, "bunx"), "#!/bin/sh\nprintf '%s' \"$SELECTOR_INVENTORY\"\n");
      chmodSync(resolve(directory, "git"), 0o755);
      chmodSync(resolve(directory, "bunx"), 0o755);
      for (const inventory of ["not json", JSON.stringify({ tasks: [] }), JSON.stringify({ tasks: [{ taskId: "invalid", directory: ".", inputs: [], dependencies: [] }] })]) {
        const process = Bun.spawnSync(["bun", selector, "--mode", "affected", "--base", "base", "--head", "head"], {
          cwd: root,
          env: { ...Bun.env, PATH: `${directory}:${Bun.env.PATH ?? ""}`, SELECTOR_INVENTORY: inventory },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(process.exitCode).toBe(0);
        expect(JSON.parse(process.stdout.toString()).mode).toBe("full");
        expect(process.stderr.toString()).toContain("selecting full inventory");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });


  test("real Turbo ranges select feature, setup, documentation, and fresh inputs", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "raceiq-impact-real-"));
    const command = (args: string[], cwd = fixture) => {
      const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`);
      return result.stdout.toString().trim();
    };
    const git = (...args: string[]) => command(["git", ...args]);
    const snapshot = (parent?: string) => {
      const tree = git("write-tree");
      const content = `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author Fixture <fixture@example.com> 1700000000 +0000\ncommitter Fixture <fixture@example.com> 1700000000 +0000\n\nfixture\n`;
      const result = Bun.spawnSync(["git", "hash-object", "-t", "commit", "-w", "--stdin"], {
        cwd: fixture, stdin: Buffer.from(content), stdout: "pipe", stderr: "pipe",
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    try {
      // Preserve the real workspace graph and task configuration without hashing unrelated source files.
      const fixtureFiles = [
        "bun.lock",
        "scripts/ci/affected-verification.ts",
        "playwright/config/projects.ts",
        "playwright/config/runtime.ts",
        "packages/tracks-catalogue/ui/track/TrackCard.tsx",
        "playwright/tests/setup/sparse-split-migration.spec.ts",
        "docs/adr/0016-task-level-affected-verification.md",
        "playwright/tests/fresh-install/fresh-install.spec.ts",
      ];
      const files = command(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".", ":(exclude).claude"], root);
      for (const path of files.split("\0").filter(Boolean)) {
        if (!fixtureFiles.includes(path) && !path.endsWith("/package.json") && path !== "package.json" &&
            !path.endsWith("/turbo.json") && path !== "turbo.json") continue;
        const source = resolve(root, path);
        let stat;
        try { stat = lstatSync(source); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (!stat.isFile() && !stat.isSymbolicLink()) continue;
        const destination = resolve(fixture, path);
        mkdirSync(dirname(destination), { recursive: true });
        if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source), destination);
        else copyFileSync(source, destination);
      }
      symlinkSync(resolve(root, "node_modules"), resolve(fixture, "node_modules"), "dir");
      git("init", "-b", "main");
      git("add", ".");
      const base = snapshot();
      const select = (path: string) => {
        git("read-tree", base);
        const target = resolve(fixture, path);
        const original = readFileSync(target);
        writeFileSync(target, Buffer.concat([original, Buffer.from("\n")]));
        git("add", path);
        const head = snapshot(base);
        git("update-ref", "refs/heads/main", head);
        git("reset", "--mixed", head);
        const output = command(["bun", resolve(fixture, "scripts/ci/affected-verification.ts"), "--mode", "affected", "--base", base, "--head", head]);
        writeFileSync(target, original);
        return JSON.parse(output);
      };
      const selectChanges = (mutate: () => void, restore: () => void) => {
        git("read-tree", base);
        mutate();
        git("add", "-A");
        const head = snapshot(base);
        git("update-ref", "refs/heads/main", head);
        git("reset", "--mixed", head);
        try {
          return JSON.parse(command(["bun", resolve(fixture, "scripts/ci/affected-verification.ts"), "--mode", "affected", "--base", base, "--head", head]));
        } finally {
          restore();
        }
      };
      const projects = (selection: { browserMatrix: { projects: string[] }[] }) =>
        new Set(selection.browserMatrix.flatMap((row) => row.projects));
      const feature = select("packages/tracks-catalogue/ui/track/TrackCard.tsx");
      expect(feature.mode).toBe("affected");
      expect(projects(feature).has("tracks-catalogue")).toBe(true);
      expect(projects(feature).has("cars-catalogue")).toBe(true);
      const setup = select("playwright/tests/setup/sparse-split-migration.spec.ts");
      expect(setup.mode).toBe("affected");
      expect(projects(setup).has("seeded-e2e")).toBe(true);
      expect(setup.seedDatabase).toBe(true);
      for (const name of ["tracks-catalogue", "cars-catalogue", "lap-replay", "sessions-page", "session-analyse"]) {
        expect(projects(setup).has(name)).toBe(true);
      }
      const docs = select("docs/adr/0016-task-level-affected-verification.md");
      expect(docs.mode).toBe("affected");
      expect(docs.browserMatrix).toHaveLength(0);
      expect(docs.seedDatabase || docs.nativeWebgpu || docs.responsive || docs.storybook).toBe(false);
      const fresh = select("playwright/tests/fresh-install/fresh-install.spec.ts");
      expect(fresh.mode).toBe("affected");
      expect(projects(fresh).has("fresh-install")).toBe(true);
      expect(fresh.seedDatabase).toBe(true);
      const unknown = resolve(fixture, "unknown-input.xyz");
      const featurePath = resolve(fixture, "packages/tracks-catalogue/ui/track/TrackCard.tsx");
      const originalFeature = readFileSync(featurePath);
      const unknownOnly = selectChanges(
        () => writeFileSync(unknown, "unknown\n"),
        () => rmSync(unknown),
      );
      expect(unknownOnly.mode).toBe("full");
      const mixed = selectChanges(
        () => { writeFileSync(unknown, "unknown\n"); writeFileSync(featurePath, Buffer.concat([originalFeature, Buffer.from("\n")])); },
        () => { rmSync(unknown); writeFileSync(featurePath, originalFeature); },
      );
      expect(mixed.mode).toBe("full");
      const deleted = selectChanges(
        () => rmSync(featurePath),
        () => writeFileSync(featurePath, originalFeature),
      );
      expect(deleted.mode).toBe("full");
      const renamedPath = `${featurePath}.renamed`;
      const renamed = selectChanges(
        () => renameSync(featurePath, renamedPath),
        () => renameSync(renamedPath, featurePath),
      );
      expect(renamed.mode).toBe("full");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 180_000);

  test("rejects invalid options", () => {
    const process = run("--mode", "unknown");
    expect(process.exitCode).not.toBe(0);
    expect(process.stdout.toString()).toBe("");
  });
});
