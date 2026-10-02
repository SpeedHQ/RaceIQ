import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { GameId } from "@raceiq/games/ids";
import { testsForGame, testsForShared } from "./select-game-tests";

const game = process.argv[2];
const gameIds: readonly GameId[] = ["fm-2023", "f1-2025", "acc", "ac-evo", "iracing", "lmu"];
if (game !== "shared" && !gameIds.includes(game as GameId)) {
  console.error("Usage: bun scripts/test/run-game-tests.ts <fm-2023|f1-2025|acc|ac-evo|iracing|lmu|shared>");
  process.exit(2);
}

const root = resolve(import.meta.dir, "../..");
const suites = ["unit", "tooling", "integration"] as const;
const selectionDir = mkdtempSync(resolve(tmpdir(), "raceiq-game-tests-"));
let status = 0;
try {
  for (const suite of suites) {
    const files = game === "shared"
      ? await testsForShared(root, suite)
      : await testsForGame(root, game as GameId, suite);
    if (files.length === 0) continue;
    console.log(`${suite}\n${files.join("\n")}`);
    const selectionPath = resolve(selectionDir, `${suite}.json`);
    writeFileSync(selectionPath, JSON.stringify(files));
    const result = Bun.spawnSync(
      [process.execPath, "scripts/test/run-suite.ts", suite, "--files", selectionPath],
      { cwd: root, stdout: "inherit", stderr: "inherit" },
    );
    status = result.exitCode;
    if (status !== 0) break;
  }
} finally {
  rmSync(selectionDir, { recursive: true, force: true });
}
process.exit(status);
