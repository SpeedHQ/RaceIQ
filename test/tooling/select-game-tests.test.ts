import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { selectGameTests, testsForGame, testsForShared } from "../../scripts/test/select-game-tests";

const unitPaths = [
  "test/games/shared/parser.test.ts",
  "test/games/kunos/shared-memory-replay.test.ts",
  "test/games/acc/acc-adapter.test.ts",
  "test/games/ac-evo/ac-evo-adapter.test.ts",
  "test/games/forza/forza-lzx.test.ts",
  "test/games/f1-2025/f1-adapter.test.ts",
  "test/games/iracing/iracing-adapter.test.ts",
  "test/games/lmu/lmu-adapter.test.ts",
];
const integrationPaths = [
  "test/games/shared/release-game-registration.test.ts",
  "test/games/kunos/shared-memory-replay.test.ts",
  "test/games/acc/acc-parser.test.ts",
  "test/games/ac-evo/ac-evo-parser.test.ts",
  "test/games/forza/forza-parser.test.ts",
  "test/games/f1-2025/f1-parser.test.ts",
  "test/games/iracing/iracing-parser.test.ts",
  "test/games/lmu/lmu-parser.test.ts",
];
const toolingPaths = [
  "test/tooling/select-game-tests.test.ts",
  "test/tooling/version-label.test.ts",
];
let root: string;

beforeAll(() => {
  root = mkdtempSync(resolve(tmpdir(), "raceiq-game-selector-"));
  mkdirSync(resolve(root, "scripts/test"), { recursive: true });
  writeFileSync(resolve(root, "scripts/test/unit-files.txt"), `${unitPaths.join("\n")}\n`);
  writeFileSync(resolve(root, "scripts/test/integration-files.txt"), `${integrationPaths.join("\n")}\n`);
  writeFileSync(resolve(root, "scripts/test/tooling-files.txt"), `${toolingPaths.join("\n")}\n`);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("manifest-based game test selection", () => {
  it("selects ACC-owned tests across suites and retains always-on tests", async () => {
    const selection = await selectGameTests(root, ["server/games/acc/parser.ts"]);
    expect(selection.games).toEqual(["acc"]);
    expect(selection.unit).toEqual([
      "test/games/acc/acc-adapter.test.ts",
      "test/games/kunos/shared-memory-replay.test.ts",
      "test/games/shared/parser.test.ts",
    ]);
    expect(selection.integration).toEqual([
      "test/games/acc/acc-parser.test.ts",
      "test/games/kunos/shared-memory-replay.test.ts",
      "test/games/shared/release-game-registration.test.ts",
    ]);
    expect(selection.tooling).toEqual(toolingPaths);
    expect(await testsForGame(root, "acc")).toEqual(["test/games/acc/acc-adapter.test.ts"]);
    expect(await testsForGame(root, "acc", "integration")).toEqual(["test/games/acc/acc-parser.test.ts"]);
  });

  it("selects all game-owned plus shared tests for shared workspace", async () => {
    expect(await testsForShared(root)).toEqual([
      "test/games/ac-evo/ac-evo-adapter.test.ts",
      "test/games/acc/acc-adapter.test.ts",
      "test/games/f1-2025/f1-adapter.test.ts",
      "test/games/forza/forza-lzx.test.ts",
      "test/games/iracing/iracing-adapter.test.ts",
      "test/games/lmu/lmu-adapter.test.ts",
      "test/games/shared/parser.test.ts",
    ]);
    expect(await testsForShared(root, "integration")).toEqual([
      "test/games/ac-evo/ac-evo-parser.test.ts",
      "test/games/acc/acc-parser.test.ts",
      "test/games/f1-2025/f1-parser.test.ts",
      "test/games/forza/forza-parser.test.ts",
      "test/games/iracing/iracing-parser.test.ts",
      "test/games/lmu/lmu-parser.test.ts",
      "test/games/shared/release-game-registration.test.ts",
    ]);
  });

  it("selects ACC and AC Evo for Kunos source changes", async () => {
    const selection = await selectGameTests(root, ["server/games/kunos/lap-index.ts"]);
    expect(selection.games).toEqual(["acc", "ac-evo"]);
    expect(selection.integration).toContain("test/games/acc/acc-parser.test.ts");
    expect(selection.integration).toContain("test/games/ac-evo/ac-evo-parser.test.ts");
  });

  it("selects LMU source and changed game-owned tests", async () => {
    const sourceSelection = await selectGameTests(root, ["shared/games/lmu/index.ts"]);
    expect(sourceSelection.games).toEqual(["lmu"]);
    const testSelection = await selectGameTests(root, ["test/games/forza/forza-parser.test.ts"]);
    expect(testSelection.games).toEqual(["fm-2023"]);
    expect(testSelection.integration).toContain("test/games/forza/forza-parser.test.ts");
    expect(testSelection.integration).not.toContain("test/games/acc/acc-parser.test.ts");
  });

  it("keeps all unrelated suite tests for docs-only or empty changes", async () => {
    for (const changed of [[], ["docs/architecture.md"]]) {
      const selection = await selectGameTests(root, changed);
      expect(selection.games).toEqual([]);
      expect(selection.unit).toEqual([
        "test/games/kunos/shared-memory-replay.test.ts",
        "test/games/shared/parser.test.ts",
      ]);
      expect(selection.integration).toEqual([
        "test/games/kunos/shared-memory-replay.test.ts",
        "test/games/shared/release-game-registration.test.ts",
      ]);
      expect(selection.tooling).toEqual(toolingPaths);
    }
  });

  it("selects all game groups for shared, config, fixture, and unknown changes", async () => {
    for (const path of [
      "shared/games/ids.ts",
      "package.json",
      "tsconfig.json",
      "test/fixtures/acc/capture.bin",
      "assets/unknown.fixture",
    ]) {
      const selection = await selectGameTests(root, [path]);
      expect(selection.games).toEqual(["fm-2023", "f1-2025", "acc", "ac-evo", "iracing", "lmu"]);
      expect(selection.integration).toHaveLength(integrationPaths.length);
      expect(selection.fullReason).toBeDefined();
    }
  });
});
