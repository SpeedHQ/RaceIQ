import { resolve } from "node:path";
import type { GameId } from "@raceiq/games/ids";

const GAME_IDS: readonly GameId[] = ["fm-2023", "f1-2025", "acc", "ac-evo", "iracing", "lmu"];
const TEST_DIR: Record<GameId, string> = {
  "fm-2023": "forza",
  "f1-2025": "f1-2025",
  acc: "acc",
  "ac-evo": "ac-evo",
  iracing: "iracing",
  lmu: "lmu",
};
const COMMON_SOURCE = [
  /^shared\/games\/(?!fm-2023\/|f1-2025\/|acc\/|ac-evo\/|iracing\/|lmu\/)/,
  /^server\/games\/(init|registry|packet-dispatch|types)\.ts$/,
  /^server\/games\/shared\//,
];
const ALWAYS_FULL = /(^|\/)(package\.json|bun\.lock|bunfig[^/]*\.toml|tsconfig[^/]*\.json|vite\.config\.[^/]+)$/;

export type TestSuite = "unit" | "tooling" | "integration";
const SUITES: readonly TestSuite[] = ["unit", "tooling", "integration"];

export interface SelectedGameTests {
  unit: string[];
  tooling: string[];
  integration: string[];
  games: GameId[];
  fullReason?: string;
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function ownerOfTest(path: string): GameId | undefined {
  const match = /^test\/games\/([^/]+)\//.exec(path);
  if (!match) return;
  return GAME_IDS.find((game) => TEST_DIR[game] === match[1]);
}

function parseManifest(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

async function readManifest(root: string, suite: TestSuite): Promise<string[]> {
  return parseManifest(await Bun.file(resolve(root, `scripts/test/${suite}-files.txt`)).text());
}

export async function testsForGame(
  root: string,
  game: GameId,
  suite: TestSuite = "unit",
): Promise<string[]> {
  return (await readManifest(root, suite)).filter((file) => ownerOfTest(file) === game).sort();
}

export async function testsForShared(root: string, suite: TestSuite = "unit"): Promise<string[]> {
  return (await readManifest(root, suite))
    .filter((file) => ownerOfTest(file) !== undefined || file.startsWith("test/games/shared/"))
    .sort();
}

export async function selectGameTests(root: string, changed: readonly string[]): Promise<SelectedGameTests> {
  const manifestEntries = await Promise.all(SUITES.map(async (suite) => [suite, await readManifest(root, suite)] as const));
  const manifests = new Map(manifestEntries);
  const paths = changed.map(normalize);
  const selected = new Set<GameId>();
  let fullReason: string | undefined;

  const sourcePaths = paths.filter((path) => !path.endsWith(".md"));
  for (const path of sourcePaths) {
    if (ALWAYS_FULL.test(path) || path.startsWith(".github/workflows/") || path.startsWith("scripts/test/") || path.startsWith("test/fixtures/") || path.startsWith("test/") && !ownerOfTest(path)) {
      fullReason = `shared or test-infrastructure change: ${path}`;
      break;
    }
    if (COMMON_SOURCE.some((pattern) => pattern.test(path))) {
      fullReason = `shared game infrastructure change: ${path}`;
      break;
    }
    const gamePath = /^(?:server|shared)\/games\/([^/]+)\//.exec(path);
    if (gamePath) {
      const game = GAME_IDS.find((id) => id === gamePath[1]);
      if (game) selected.add(game);
      else if (gamePath[1] === "kunos") {
        selected.add("acc");
        selected.add("ac-evo");
      } else {
        fullReason = `unmapped game source change: ${path}`;
        break;
      }
      continue;
    }
    if (path.startsWith("server/games/") || path.startsWith("shared/games/")) {
      fullReason = `shared game infrastructure change: ${path}`;
      break;
    }
    if (path.startsWith("test/games/")) {
      const game = ownerOfTest(path);
      if (game) selected.add(game);
      else if (!path.startsWith("test/games/shared/") && !path.startsWith("test/games/kunos/")) {
        fullReason = `unmapped game test change: ${path}`;
        break;
      }
      continue;
    }
    fullReason = `unclassified change: ${path}`;
    break;
  }
  if (fullReason) for (const game of GAME_IDS) selected.add(game);

  const selectFiles = (manifest: string[]) => manifest
    .filter((file) => {
      const game = ownerOfTest(file);
      return game === undefined || selected.has(game);
    })
    .sort();
  return {
    unit: selectFiles(manifests.get("unit")!),
    tooling: selectFiles(manifests.get("tooling")!),
    integration: selectFiles(manifests.get("integration")!),
    games: GAME_IDS.filter((game) => selected.has(game)),
    ...(fullReason ? { fullReason } : {}),
  };
}
