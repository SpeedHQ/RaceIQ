import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const selector = resolve(root, "scripts/ci/affected-verification.ts");
const queryInventory = JSON.stringify({
  tasks: [
    ...Object.keys(JSON.parse(readFileSync(resolve(root, "playwright/turbo.json"), "utf8")).tasks as object)
      .map((task) => `raceiq-e2e#${task}`),
    ...["tracks-catalogue", "cars-catalogue", "lap-replay", "sessions-page", "session-analyse"].map((owner) => `@raceiq/${owner}#e2e:impact`),
  ].map((taskId) => ({ taskId, directory: ".", inputs: { "scripts/i18n/check-message-keys.ts": "hash" }, dependencies: [] })),
});

function run(...args: string[]) {
  return Bun.spawnSync(["bun", selector, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
}

const fakeGit = `#!/bin/sh
case "$*" in
  *--is-shallow-repository*) echo false;;
  *not-a-ref*) echo 'invalid ref' >&2; exit 1;;
  'rev-parse --verify HEAD') echo b;;
  *base*'^{commit}') echo a;;
  *'^{commit}') echo b;;
  'merge-base --all '*) echo a;;
  'status '*) ;;
  'diff '*) printf 'M\\0scripts/i18n/check-message-keys.ts\\0';;
esac
`;

function runWithQuery(output: string, args = ["--mode", "affected", "--base", "base", "--head", "head"], fail = false, git = fakeGit) {
  const directory = mkdtempSync(resolve(tmpdir(), "raceiq-selector-query-"));
  try {
    writeFileSync(resolve(directory, "git"), git, { mode: 0o755 });
    writeFileSync(resolve(directory, "bunx"), `#!/bin/sh
case "$*" in
  *--dry=json*) printf '%s' "$SELECTOR_INVENTORY";;
  *) ${fail ? "echo 'injected query failure' >&2; exit 1" : `printf '%s' "$SELECTOR_QUERY"`};;
esac
`, { mode: 0o755 });
    return Bun.spawnSync([process.execPath, selector, ...args], {
      cwd: root,
      env: { ...Bun.env, PATH: `${directory}:${Bun.env.PATH ?? ""}`, SELECTOR_QUERY: output, SELECTOR_INVENTORY: queryInventory },
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

  test("malformed output and unknown impact ownership fall back to full", () => {
    for (const output of [
      "not json",
      JSON.stringify({ data: { affectedTasks: { length: 1, items: [] } } }),
      JSON.stringify({ data: { affectedTasks: { length: 1, items: [
        { name: "e2e:impact", fullName: "@raceiq/not-a-workspace#e2e:impact", package: { name: "@raceiq/not-a-workspace" } },
      ] } } }),
    ]) {
      const process = runWithQuery(output);
      expect(process.exitCode).toBe(0);
      expect(JSON.parse(process.stdout.toString()).mode).toBe("full");
      expect(process.stderr.toString()).toContain("selecting full inventory");
    }
  }, 30_000);

  test("a head differing from the checkout selects full", () => {
    const result = runWithQuery("", undefined, false, fakeGit.replace("echo b;;\n  *base*", "echo c;;\n  *base*"));
    expect(JSON.parse(result.stdout.toString()).mode).toBe("full");
    expect(result.stderr.toString()).toContain("verification head does not match checkout");
  });

  test("a valid but incomplete query cannot pass as unaffected", () => {
    const result = runWithQuery(JSON.stringify({ data: { affectedTasks: { length: 0, items: [] } } }));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).mode).toBe("full");
    expect(result.stderr.toString()).toContain("Turbo omitted an affected input consumer");
  });

  test("real Turbo selects independent jobs, transitive consumers, and previous owners", () => {
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
        ".gitignore",
        "UNRELEASED.md",
        "client/src/main.tsx",
        "client/src/components/home/HomePageView.tsx",
        "client/src/components/tunes/ExperimentWorkspace.tsx",
        "client/src/components/tunes/experiment/ExperimentList.tsx",
        "client/src/components/ui/table.tsx",
        "client/src/routes/index.tsx",
        "client/src/routes/fm23/index.tsx",
        "client/src/routes/$gameid/experiments.$experimentId.tsx",
        "client/src/routes/$gameid/cars.tsx",
        "client/src/routes/$gameid/tracks.index.tsx",
        "packages/cars-catalogue/ui/cars/CarsPage.tsx",
        "packages/cars-catalogue/test/e2e/lmu-cars.spec.ts",
        "packages/cars-catalogue/server/car-routes.ts",
        "packages/tracks-catalogue/server/catalog-routes.ts",
        "server/db/discovered-cars.ts",
        "server/db/lap-read-queries.ts",
        "server/db/schema.ts",
        "server/db/track-queries.ts",
        "server/session-capture/direct-recorder.ts",
        "apps/backend/test/session-capture/direct-recorder.test.ts",
        "packages/game-lmu/test/e2e/browser/settings/lmu-recording-policy.spec.ts",
        "playwright/tests/seeded/settings/storage.spec.ts",
        "bun.lock",
        "scripts/ci/affected-verification.ts",
        "playwright/config/projects.ts",
        "playwright/config/runtime.ts",
        "packages/tracks-catalogue/ui/track/TrackCard.tsx",
        "packages/tracks-catalogue/test/e2e/tracks.spec.ts",
        "packages/lap-replay/test/e2e/compare/spectate-transition.spec.ts",
        "playwright/tests/tunes/fm23.spec.ts",
        "playwright/tests/responsive/mobile-screenshots.spec.ts",
        "scripts/i18n/check-message-keys.ts",
        "apps/desktop/src-tauri/Cargo.toml",
        "client/.storybook/main.ts",
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
      const assertAffected = (selection: { mode: string; reason: string }) => expect(selection.mode, selection.reason).toBe("affected");
      const feature = select("packages/tracks-catalogue/ui/track/TrackCard.tsx");
      assertAffected(feature);
      expect(projects(feature).has("tracks-catalogue")).toBe(true);
      expect(projects(feature).has("sessions-page")).toBe(true);
      expect(projects(feature).has("cars-catalogue")).toBe(false);
      const cars = select("packages/cars-catalogue/ui/cars/CarsPage.tsx");
      assertAffected(cars);
      expect(projects(cars).has("cars-catalogue")).toBe(true);
      expect(projects(cars).has("tracks-catalogue")).toBe(false);
      expect(projects(cars).has("seeded-imports")).toBe(false);
      const lmuCars = select("packages/cars-catalogue/test/e2e/lmu-cars.spec.ts");
      assertAffected(lmuCars);
      expect(projects(lmuCars)).toEqual(new Set(["cars-catalogue"]));
      for (const [path, owner, peer] of [
        ["client/src/routes/$gameid/cars.tsx", "cars-catalogue", "tracks-catalogue"],
        ["client/src/routes/$gameid/tracks.index.tsx", "tracks-catalogue", "cars-catalogue"],
      ] as const) {
        const selection = select(path);
        assertAffected(selection);
        expect(projects(selection).has(owner)).toBe(true);
        expect(projects(selection).has(peer)).toBe(false);
      }
      for (const [path, owner, peer] of [
        ["packages/cars-catalogue/server/car-routes.ts", "cars-catalogue", "tracks-catalogue"],
        ["packages/tracks-catalogue/server/catalog-routes.ts", "tracks-catalogue", "cars-catalogue"],
      ] as const) {
        const selection = select(path);
        assertAffected(selection);
        expect(projects(selection).has(owner)).toBe(true);
        expect(projects(selection).has(peer)).toBe(false);
      }
      const recorderPaths = [
        "server/session-capture/direct-recorder.ts",
        "apps/backend/test/session-capture/direct-recorder.test.ts",
        "UNRELEASED.md",
      ].map((path) => resolve(fixture, path));
      const originalRecorderFiles = recorderPaths.map((path) => readFileSync(path));
      const recorder = selectChanges(
        () => recorderPaths.forEach((path, i) => writeFileSync(path, Buffer.concat([originalRecorderFiles[i]!, Buffer.from("\n")]))),
        () => recorderPaths.forEach((path, i) => writeFileSync(path, originalRecorderFiles[i]!)),
      );
      assertAffected(recorder);
      expect(projects(recorder).has("cars-catalogue")).toBe(false);
      expect(projects(recorder).has("tracks-catalogue")).toBe(true);
      expect(projects(recorder).has("seeded-imports")).toBe(true);
      for (const path of [
        "packages/game-lmu/test/e2e/browser/settings/lmu-recording-policy.spec.ts",
        "playwright/tests/seeded/settings/storage.spec.ts",
      ]) {
        const recording = select(path);
        assertAffected(recording);
        expect(projects(recording).has("seeded-imports"), path).toBe(true);
        expect(projects(recording).has("cars-catalogue"), path).toBe(false);
      }
      const lmuFixture = resolve(fixture, "packages/game-lmu/test/fixtures/sessions/impact-fixture.bin.gz");
      const addedFixture = selectChanges(
        () => { mkdirSync(dirname(lmuFixture), { recursive: true }); writeFileSync(lmuFixture, "fixture"); },
        () => rmSync(lmuFixture),
      );
      assertAffected(addedFixture);
      expect(projects(addedFixture).has("seeded-imports")).toBe(true);
      const carDiscovery = select("server/db/discovered-cars.ts");
      assertAffected(carDiscovery);
      expect(projects(carDiscovery).has("cars-catalogue")).toBe(true);
      const lapQueries = select("server/db/lap-read-queries.ts");
      assertAffected(lapQueries);
      expect(projects(lapQueries).has("tracks-catalogue")).toBe(true);
      expect(projects(lapQueries).has("cars-catalogue")).toBe(false);
      const trackCounts = select("server/db/track-queries.ts");
      assertAffected(trackCounts);
      expect(projects(trackCounts).has("tracks-catalogue")).toBe(true);
      expect(projects(trackCounts).has("cars-catalogue")).toBe(false);
      const schema = select("server/db/schema.ts");
      assertAffected(schema);
      expect(projects(schema).has("cars-catalogue")).toBe(true);
      expect(projects(schema).has("tracks-catalogue")).toBe(true);
      expect(projects(schema).has("seeded-imports")).toBe(true);
      for (const path of [
        "client/src/components/home/HomePageView.tsx",
        "client/src/components/tunes/ExperimentWorkspace.tsx",
        "client/src/components/tunes/experiment/ExperimentList.tsx",
        "client/src/routes/index.tsx",
        "client/src/routes/fm23/index.tsx",
        "client/src/routes/$gameid/experiments.$experimentId.tsx",
      ]) {
        const selection = select(path);
        assertAffected(selection);
        expect(projects(selection).has("cars-catalogue"), path).toBe(false);
        expect(projects(selection).has("tracks-catalogue"), path).toBe(false);
        expect(selection.build, path).toBe(true);
      }
      const newHomePanel = resolve(fixture, "client/src/components/home/NewPanel.tsx");
      const added = selectChanges(
        () => writeFileSync(newHomePanel, "export const NewPanel = () => null;\n"),
        () => rmSync(newHomePanel),
      );
      assertAffected(added);
      expect(projects(added).has("cars-catalogue")).toBe(false);
      expect(projects(added).has("tracks-catalogue")).toBe(false);
      expect(added.build).toBe(true);
      const sharedTable = select("client/src/components/ui/table.tsx");
      assertAffected(sharedTable);
      expect(projects(sharedTable).has("cars-catalogue")).toBe(true);
      expect(projects(sharedTable).has("tracks-catalogue")).toBe(true);
      const setup = select("playwright/tests/setup/sparse-split-migration.spec.ts");
      assertAffected(setup);
      expect(projects(setup).has("seeded-e2e")).toBe(true);
      expect(setup.seedDatabase).toBe(true);
      for (const name of ["tracks-catalogue", "cars-catalogue", "lap-replay", "sessions-page", "session-analyse"]) {
        expect(projects(setup).has(name)).toBe(true);
      }
      const docs = select("docs/adr/0016-task-level-affected-verification.md");
      assertAffected(docs);
      expect(docs.browserMatrix).toHaveLength(0);
      expect(docs.seedDatabase || docs.nativeWebgpu || docs.responsive || docs.storybook || docs.build || docs.desktop).toBe(false);
      expect(docs.expected.test).toBe(true);
      const policyNote = select("UNRELEASED.md");
      assertAffected(policyNote);
      expect(policyNote.expected).toEqual(docs.expected);
      const shared = select("client/src/main.tsx");
      assertAffected(shared);
      expect(shared.browserMatrix).toHaveLength(10);
      expect(shared.build && shared.desktop && shared.nativeWebgpu && shared.responsive && shared.storybook).toBe(true);
      const fresh = select("playwright/tests/fresh-install/fresh-install.spec.ts");
      assertAffected(fresh);
      expect(projects(fresh)).toEqual(new Set(["fresh-install"]));
      expect(fresh.seedDatabase || fresh.nativeWebgpu || fresh.build || fresh.desktop || fresh.responsive || fresh.storybook).toBe(false);
      const tracks = select("packages/tracks-catalogue/test/e2e/tracks.spec.ts");
      assertAffected(tracks);
      expect(projects(tracks)).toEqual(new Set(["tracks-catalogue"]));
      expect(tracks.browserMatrix.map((row: { shard: string }) => row.shard)).toEqual(["1/7", "2/7", "3/7", "4/7", "5/7", "6/7", "7/7"]);
      expect(tracks.seedDatabase).toBe(true);
      expect(tracks.nativeWebgpu || tracks.build).toBe(false);
      const webgpu = select("packages/lap-replay/test/e2e/compare/spectate-transition.spec.ts");
      assertAffected(webgpu);
      expect(webgpu.nativeWebgpu && webgpu.seedDatabase).toBe(true);
      expect(webgpu.browserMatrix).toEqual([]);
      const tune = select("playwright/tests/tunes/fm23.spec.ts");
      assertAffected(tune);
      expect(projects(tune)).toEqual(new Set(["tunes"]));
      expect(tune.seedDatabase).toBe(false);
      const desktop = select("apps/desktop/src-tauri/Cargo.toml");
      assertAffected(desktop);
      expect(desktop.desktop).toBe(true);
      expect(desktop.build || desktop.browserMatrix.length > 0 || desktop.responsive || desktop.storybook).toBe(false);
      const locale = select("scripts/i18n/check-message-keys.ts");
      assertAffected(locale);
      expect(locale.checks).toEqual({ shards: false, locales: true, dbUpgrade: false, telemetry: false });
      expect(locale.desktop || locale.build || locale.browserMatrix.length > 0 || locale.responsive || locale.storybook).toBe(false);
      const responsive = select("playwright/tests/responsive/mobile-screenshots.spec.ts");
      assertAffected(responsive);
      expect(responsive.artifacts.previews).toEqual(["responsive"]);
      const storybook = select("client/.storybook/main.ts");
      assertAffected(storybook);
      expect(storybook.artifacts.previews).toEqual(["storybook"]);
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
      const owned = resolve(fixture, "packages/tracks-catalogue/test/e2e/tracks.spec.ts");
      const originalSpec = readFileSync(owned);
      const deleted = selectChanges(() => rmSync(owned), () => writeFileSync(owned, originalSpec));
      assertAffected(deleted);
      expect(projects(deleted)).toEqual(new Set(["tracks-catalogue"]));
      const renamedPath = resolve(fixture, "playwright/tests/seeded/routes/tracks.spec.ts");
      mkdirSync(dirname(renamedPath), { recursive: true });
      const renamed = selectChanges(() => renameSync(owned, renamedPath), () => renameSync(renamedPath, owned));
      assertAffected(renamed);
      expect(projects(renamed)).toEqual(new Set(["tracks-catalogue", "seeded-routes"]));
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

describe("visual preview publication", () => {
  test("combines only selected suites and rejects missing or inconsistent metadata", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "raceiq-preview-"));
    const output = resolve(directory, "pr-preview");
    const base = "a".repeat(40);
    const artifacts = resolve(directory, "artifacts");
    const runCombine = (responsive: boolean, storybook: boolean) => {
      rmSync(output, { recursive: true, force: true });
      return Bun.spawnSync([process.execPath, resolve(root, "scripts/ci/combine-pr-visual-previews.ts")], {
        cwd: directory,
        env: { ...Bun.env, PREVIEW_ROOT: artifacts, PREVIEW_PR: "519", PREVIEW_BASE: base,
          PREVIEW_RESPONSIVE: String(responsive), PREVIEW_STORYBOOK: String(storybook) },
        stdout: "pipe",
        stderr: "pipe",
      });
    };
    try {
      for (const suite of ["responsive", "storybook"]) {
        const artifact = resolve(artifacts, `pr-visual-${suite}-preview`);
        for (const side of ["base", "current"]) {
          const render = resolve(artifact, `${side}-${suite}`);
          mkdirSync(render, { recursive: true });
          writeFileSync(resolve(render, "render.png"), `${side}-${suite}`);
        }
        writeFileSync(resolve(artifact, "pr-number.txt"), "519\n");
        writeFileSync(resolve(artifact, "base-ref.txt"), `${base}\n`);
      }
      for (const [responsive, storybook] of [[true, false], [false, true], [true, true], [false, false]] as const) {
        const result = runCombine(responsive, storybook);
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(existsSync(output)).toBe(responsive || storybook);
        expect(existsSync(resolve(output, "current-responsive/render.png"))).toBe(responsive);
        expect(existsSync(resolve(output, "base-storybook/render.png"))).toBe(storybook);
      }
      const storybookMeta = resolve(artifacts, "pr-visual-storybook-preview/base-ref.txt");
      writeFileSync(storybookMeta, "b".repeat(40));
      expect(runCombine(true, true).exitCode).toBe(1);
      expect(runCombine(false, true).exitCode).toBe(1);
      rmSync(storybookMeta);
      expect(runCombine(true, false).exitCode).toBe(0);
      expect(runCombine(true, true).exitCode).toBe(1);
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("required workflow conclusions", () => {
  test("rejects failed, cancelled, and missing selected jobs or matrix rows", () => {
    const workflow = (file: string, job: string, step: string) => {
      const path = resolve(root, `.github/workflows/${file}.yml`);
      const { jobs } = Bun.YAML.parse(readFileSync(path, "utf8")) as {
        jobs: Record<string, { steps: { name: string; with?: { script: string } }[] }>;
      };
      const script = jobs[job]?.steps.find(({ name }) => name === step)?.with?.script;
      if (!script) throw new Error(`Missing workflow gate: ${job}/${step}`);
      return new Function("process", "require", script) as (process: { env: Record<string, string> }, load: NodeJS.Require) => void;
    };
    const aggregate = workflow("build-test", "verification", "Verify selected job conclusions");
    const expected = { build: false, "macos-desktop": false, test: true, changelog: true, "playwright-e2e": true, "visual-regression": false };
    const parentEnv = (browserConclusion: string) => ({
      env: {
        ELIGIBLE: "true",
        PLAN: JSON.stringify({ expected }),
        RESULTS: JSON.stringify({
          plan: { result: "success" },
          ...Object.fromEntries(Object.entries(expected).map(([name, run]) => [
            name, { result: name === "playwright-e2e" ? browserConclusion : run ? "success" : "skipped" },
          ])),
        }),
      },
    });
    expect(() => aggregate(parentEnv("success"), require)).not.toThrow();
    for (const conclusion of ["failure", "cancelled", "skipped"]) {
      expect(() => aggregate(parentEnv(conclusion), require)).toThrow(`playwright-e2e: expected success, got ${conclusion}`);
    }
    const invalid = parentEnv("skipped");
    invalid.env.PLAN = "";
    expect(() => aggregate(invalid, require)).toThrow();

    const browser = workflow("playwright-e2e", "browser-results", "Verify selected browser jobs");
    const receipts = mkdtempSync(resolve(tmpdir(), "raceiq-browser-receipts-"));
    try {
      const env = {
        PLAN: JSON.stringify({ matrix: [{ name: "fresh", serverSet: "fresh" }], nativeWebgpu: false, seedDatabase: false }),
        PREPARE: "skipped", STANDALONE: "false", SEED: "skipped", MATRIX: "success",
        WEBGPU: "skipped", ENABLE_WEBGPU: "true", RECEIPTS: receipts,
      };
      expect(() => browser({ env }, require)).toThrow("fresh.txt");
      writeFileSync(resolve(receipts, "fresh.txt"), "fresh");
      expect(() => browser({ env }, require)).not.toThrow();
      expect(() => browser({ env: { ...env, MATRIX: "skipped" } }, require)).toThrow("MATRIX: unexpected skipped");
    } finally {
      rmSync(receipts, { recursive: true, force: true });
    }
  });
});
