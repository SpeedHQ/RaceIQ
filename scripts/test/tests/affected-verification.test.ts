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

function runWithQuery(output: string, args = ["--mode", "affected", "--base", "base", "--head", "head"], fail = false, git = "#!/bin/sh\ncase \"$*\" in *--is-shallow-repository*) echo false;; *not-a-ref*) echo 'invalid ref' >&2; exit 1;; *) case \"$1\" in diff) printf 'docs/example.md\\0';; *) case \"$*\" in *base*) echo a;; *) echo b;; esac;; esac;; esac\n") {
  const directory = mkdtempSync(resolve(tmpdir(), "raceiq-selector-query-"));
  try {
    writeFileSync(resolve(directory, "git"), git);
    writeFileSync(resolve(directory, "bunx"), fail
      ? "#!/bin/sh\nprintf 'injected query failure\\n' >&2\nexit 1\n"
      : "#!/bin/sh\nprintf '%s' \"$SELECTOR_QUERY\"\n");
    chmodSync(resolve(directory, "git"), 0o755);
    chmodSync(resolve(directory, "bunx"), 0o755);
    return Bun.spawnSync(["bun", selector, ...args], {
      cwd: root,
      env: { ...Bun.env, PATH: `${directory}:${Bun.env.PATH ?? ""}`, SELECTOR_QUERY: output },
      stdout: "pipe",
      stderr: "pipe",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function runBrowserWrapper(selection: string, dryRun: string, shallow = "false", task = "ci:browser") {
  const directory = mkdtempSync(resolve(tmpdir(), "raceiq-browser-wrapper-"));
  try {
    mkdirSync(resolve(directory, "scripts/ci"), { recursive: true });
    copyFileSync(resolve(root, "scripts/ci/run-affected-browser.ts"), resolve(directory, "scripts/ci/run-affected-browser.ts"));
    const bin = resolve(directory, "bin");
    mkdirSync(bin);
    writeFileSync(resolve(bin, "git"), "#!/bin/sh\nprintf '%s\\n' \"$SHALLOW\"\n");
    writeFileSync(resolve(bin, "bun"), "#!/bin/sh\nprintf '%s\\n' \"$SELECTION\"\n");
    writeFileSync(resolve(bin, "bunx"), "#!/bin/sh\ncase \"$*\" in *--dry=json*) printf '%s\\n' \"$DRY_RUN\";; *) printf '%s\\n' \"$*\" > \"$COMMAND_LOG\";; esac\n");
    for (const name of ["git", "bun", "bunx"]) chmodSync(resolve(bin, name), 0o755);
    const log = resolve(directory, "command");
    const result = Bun.spawnSync([process.execPath, resolve(directory, "scripts/ci/run-affected-browser.ts"), task, "--shard=2/7"], {
      cwd: directory,
      env: { ...Bun.env, PATH: `${bin}:${Bun.env.PATH ?? ""}`, CI_VERIFICATION_MODE: "affected", TURBO_SCM_BASE: "base", TURBO_SCM_HEAD: "head", SHALLOW: shallow, SELECTION: selection, DRY_RUN: dryRun, COMMAND_LOG: log, GITHUB_OUTPUT: resolve(directory, "output") },
      stdout: "pipe", stderr: "pipe",
    });
    return { result, command: readFileSync(log, "utf8"), output: readFileSync(resolve(directory, "output"), "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("CI browser Turbo execution", () => {
  test("passes affected selection and the original shard to Turbo", () => {
    const { result, command } = runBrowserWrapper('{"mode":"affected","browserMatrix":[{}],"responsive":false,"storybook":false}', '{"tasks":[{"taskId":"raceiq-e2e#ci:browser"}]}');
    expect(result.exitCode).toBe(0);
    expect(command).toContain("--affected");
    expect(command).toContain("--shard=2/7");
  });

  test("uncertain selection, missing task, and shallow history run the full task", () => {
    for (const [selection, dry, shallow] of [
      ["invalid", "{}", "false"],
      ['{"mode":"affected","browserMatrix":[{}],"responsive":false,"storybook":false}', '{"tasks":[]}', "false"],
      ['{"mode":"affected","browserMatrix":[],"responsive":false,"storybook":false}', '{"tasks":[]}', "true"],
    ]) {
      const { result, command } = runBrowserWrapper(selection, dry, shallow);
      expect(result.exitCode).toBe(0);
      expect(command).not.toContain("--affected");
      expect(result.stderr.toString()).toContain("running full browser task");
    }
  });

  test("utility tasks fall back to full when affected inventory omits changed verification inputs", () => {
    const { result, command } = runBrowserWrapper(
      '{"mode":"affected","browserMatrix":[],"responsive":true,"storybook":false}',
      '{"tasks":[]}',
      "false",
      "ci:check-locales",
    );
    expect(result.exitCode).toBe(0);
    expect(command).not.toContain("--affected");
    expect(command).toContain("ci:check-locales");
  });

  test("unaffected visual tasks expose a skipped selection for artifact handling", () => {
    const { result, command, output } = runBrowserWrapper(
      '{"mode":"affected","browserMatrix":[],"responsive":false,"storybook":false}',
      '{"tasks":[]}',
      "false",
      "ci:responsive-current",
    );
    expect(result.exitCode).toBe(0);
    expect(command).toContain("--affected");
    expect(output).toContain("selected=false");
  });
});


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
    for (const [args, reason] of [
      [["--mode", "affected"], "affected mode requires both refs"],
      [["--mode", "affected", "--base", "not-a-ref", "--head", "HEAD"], "invalid ref"],
      [["--mode", "affected", "--base", "HEAD", "--head", "HEAD"], "equal refs"],
    ] as const) {
      const process = runWithQuery("", [...args]);
      expect(process.exitCode).toBe(0);
      expect(JSON.parse(process.stdout.toString()).mode).toBe("full");
      expect(process.stderr.toString()).toContain(`${reason}; selecting full inventory`);
    }
  });

  test("shallow repositories fall back to full with a diagnostic", () => {
    const process = runWithQuery("", undefined, false, "#!/bin/sh\necho true\n");
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(process.stdout.toString()).mode).toBe("full");
    expect(process.stderr.toString()).toContain("shallow repository; selecting full inventory");
  });

  test("explicitly empty refs fall back to the full inventory", () => {
    const fullSelection = JSON.parse(run("--mode", "full").stdout.toString());
    for (const args of [
      ["--mode", "affected", "--base", "", "--head", "HEAD"],
      ["--mode", "affected", "--base", "HEAD", "--head", ""],
    ]) {
      const process = runWithQuery("", args);
      expect(process.exitCode).toBe(0);
      const selection = JSON.parse(process.stdout.toString());
      expect(selection.mode).toBe("full");
      expect(selection.browserMatrix).toEqual(fullSelection.browserMatrix);
      expect(selection.seedDatabase).toBe(fullSelection.seedDatabase);
      expect(selection.nativeWebgpu).toBe(fullSelection.nativeWebgpu);
      expect(selection.responsive).toBe(fullSelection.responsive);
      expect(selection.storybook).toBe(fullSelection.storybook);
      expect(process.stderr.toString()).toContain("affected mode requires both refs; selecting full inventory");
    }
  });

  test("a failed Turbo query falls back to full instead of reporting no work", () => {
    const process = runWithQuery("", ["--mode", "affected", "--base", "base", "--head", "head"], true);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(process.stdout.toString()).mode).toBe("full");
    expect(process.stderr.toString()).toContain("injected query failure");
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
      writeFileSync(resolve(directory, "git"), "#!/bin/sh\ncase \"$*\" in *--is-shallow-repository*) echo false;; *) case \"$1\" in diff) printf 'src/input.ts\\0';; *) case \"$*\" in *base*) echo a;; *) echo b;; esac;; esac;; esac\n");
      writeFileSync(resolve(directory, "bunx"), "#!/bin/sh\nprintf '%s' \"$SELECTOR_INVENTORY\"\n");
      chmodSync(resolve(directory, "git"), 0o755);
      chmodSync(resolve(directory, "bunx"), 0o755);
      for (const [inventory, reason] of [
        ["not json", "JSON"],
        [JSON.stringify({ tasks: [] }), "missing Turbo task inventory:"],
        [JSON.stringify({ tasks: [{ taskId: "invalid", directory: ".", inputs: [], dependencies: [] }] }), "malformed Turbo task inventory"],
      ]) {
        const process = Bun.spawnSync(["bun", selector, "--mode", "affected", "--base", "base", "--head", "head"], {
          cwd: root,
          env: { ...Bun.env, PATH: `${directory}:${Bun.env.PATH ?? ""}`, SELECTOR_INVENTORY: inventory },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(process.exitCode).toBe(0);
        expect(JSON.parse(process.stdout.toString()).mode).toBe("full");
        expect(process.stderr.toString()).toContain(reason);
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
    for (const args of [
      ["--mode", "unknown"],
      ["--mode", "affected", "--base"],
      ["--mode", "affected", "--base", "--head", "HEAD"],
      ["--mode", "affected", "--unknown", ""],
    ]) {
      const process = run(...args);
      expect(process.exitCode).not.toBe(0);
      expect(process.stdout.toString()).toBe("");
    }
  });
});
