import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

const PROJECT_DIR = resolve(import.meta.dir, "../..");
const CLIENT_SOURCE_DIR = resolve(PROJECT_DIR, "client/src");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

// Keep exemptions file-specific. Broad directory exemptions let normal consumers
// silently regain native packet authority.
const ALLOWED_CLIENT_FILES = new Set([
  "components/RawTelemetry.tsx",
  "components/dev/DevTelemetryPanel.tsx",
  "stores/dev-telemetry.ts",
  "lib/websocket-messages.ts",
  // Native-shaped fixtures support resolver parity and raw/dev tests.
  "stories/fakeData.ts",
]);

const ALLOWED_SERVER_FILES = new Set([
  // Explicit development replay/inspection boundary.
  "server/routes/dev/replay-routes.ts",
  "server/runtime/websocket-manager.ts",
  "server/live-strategy/pit-tracker.ts",
  "server/live-strategy/sector-tracker.ts",
  // Source-recording integrity runs before semantic replay exists.
  "server/lap-analysis/quality.ts",
  // Reconciliation retains packets only for canonical input hashing.
  "server/race-results/reconcile.ts",
  "server/race-results/canonical-input.ts",
]);

const NORMAL_SERVER_ROOTS = [
  "server/ai",
  "server/driver-profile",
  "server/experiments",
  "server/findings",
  "server/lap-analysis",
  "server/live-strategy",
  "server/race-results",
  "server/routes",
  "server/runtime",
  "server/tracks",
  "shared/racing/analysis",
  "shared/racing/laps/trace",
  "mastra/tools",
] as const;

const FORBIDDEN_CLIENT_TOKENS = /\b(TelemetryPacket|DisplayPacket|rawPacket)\b/g;
const FORBIDDEN_SERVER_PATTERNS = [
  ["TelemetryPacket import", /from\s+["'][^"']*shared\/telemetry\/types["']/g],
  ["raw lap decoder", /\b(?:getLapById|getLapsByIds)\b/g],
  ["raw corner resolver", /\bresolveLapCorners\b/g],
  ["obsolete replay converter", /\bcomparisonSamplesFromReplay\b/g],
] as const;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (entry.name === "routeTree.gen.ts") return [];
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

function projectPath(path: string): string {
  return relative(PROJECT_DIR, path).replaceAll("\\", "/");
}

const clientViolations = sourceFiles(CLIENT_SOURCE_DIR)
  .map((path) => ({ path, relativePath: relative(CLIENT_SOURCE_DIR, path).replaceAll("\\", "/") }))
  .filter(({ relativePath }) => !ALLOWED_CLIENT_FILES.has(relativePath))
  .flatMap(({ path, relativePath }) => {
    const source = readFileSync(path, "utf8");
    const tokens = [...source.matchAll(FORBIDDEN_CLIENT_TOKENS)].map((match) => match[1]);
    return tokens.length > 0 ? [`${relativePath}: ${[...new Set(tokens)].sort().join(", ")}`] : [];
  })
  .sort();

const serverViolations = NORMAL_SERVER_ROOTS.flatMap((root) => sourceFiles(resolve(PROJECT_DIR, root)))
  .map((path) => ({ path, relativePath: projectPath(path) }))
  .filter(({ relativePath }) => !ALLOWED_SERVER_FILES.has(relativePath))
  .flatMap(({ path, relativePath }) => {
    const source = readFileSync(path, "utf8");
    return FORBIDDEN_SERVER_PATTERNS.flatMap(([label, pattern]) => {
      pattern.lastIndex = 0;
      return pattern.test(source) ? [`${relativePath}: ${label}`] : [];
    });
  })
  .sort();

test("keeps normal client UI on semantic telemetry views", () => {
  expect(clientViolations).toEqual([]);
});

test("keeps normal server and Mastra consumers on semantic telemetry", () => {
  expect(serverViolations).toEqual([]);
});
