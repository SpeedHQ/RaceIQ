import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(import.meta.dir, "..", path), "utf8");

function readTree(path: string) {
  const sources: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) sources.push(readFileSync(entryPath, "utf8"));
    }
  };
  visit(resolve(import.meta.dir, "..", path));
  return sources;
}

describe("responsive workspace contract", () => {
  test("analysis and comparison use shared container boundary", () => {
    const workspace = read("client/src/components/ResponsiveWorkspace.tsx");
    const analyseRoute = read("client/src/routes/$gameid/analyse.tsx");
    const compareRoute = read("client/src/routes/$gameid/compare.tsx");

    expect(workspace).toContain("@container/workspace");
    expect(workspace).toContain("overflow-x-hidden");
    expect(analyseRoute).toContain("<ResponsiveWorkspace>");
    expect(compareRoute).toContain("<ResponsiveWorkspace>");
  });

  test("feature components do not own viewport gates", () => {
    const featureSources = [
      read("client/src/components/LapAnalyse.tsx"),
      read("client/src/components/LapComparison.tsx"),
      ...readTree("client/src/components/analyse"),
      ...readTree("client/src/components/comparison"),
    ];

    for (const source of featureSources) {
      expect(source).not.toContain("window.innerWidth");
      expect(source).not.toContain("window.innerHeight");
      expect(source).not.toContain('addEventListener("resize"');
      expect(source).not.toContain("orientationchange");
      expect(source).not.toContain("MobileNotSupported");
    }
  });

  test("blocking rotation and unsupported helpers stay removed", () => {
    const root = read("client/src/routes/__root.tsx");
    const sessions = read("client/src/components/SessionsPage.tsx");
    const tuneLive = read("client/src/components/tunes/TuneLiveDashboard.tsx");
    const dash = read("client/src/routes/dash.index.tsx");

    expect(root).not.toContain("function MobileNotSupported");
    expect(root).not.toContain("function RotatePrompt");
    for (const source of [sessions, tuneLive, dash]) {
      expect(source).not.toContain("RotatePrompt");
    }
  });

  test("dense workspaces define stacked and wide compositions", () => {
    const analyse = read("client/src/components/LapAnalyse.tsx");
    const compare = read("client/src/components/LapComparison.tsx");
    const analyseTop = read("client/src/components/analyse/AnalyseTopSection.tsx");

    expect(analyse).toContain("@5xl/workspace:flex-row");
    expect(compare).toContain("@5xl/workspace:flex-row");
    expect(analyseTop).toContain("@5xl/workspace:flex-row");
  });
});
