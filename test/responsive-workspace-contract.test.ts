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
  test("app shell owns one shared container boundary for every route", () => {
    const workspace = read("client/src/components/ResponsiveWorkspace.tsx");
    const root = read("client/src/routes/__root.tsx");
    const analyseRoute = read("client/src/routes/$gameid/analyse.tsx");
    const compareRoute = read("client/src/routes/$gameid/compare.tsx");

    expect(workspace).toContain("@container/workspace");
    expect(workspace).toContain("overflow-x-hidden");
    expect(root).toContain("<ResponsiveWorkspace>");
    expect(analyseRoute).not.toContain("ResponsiveWorkspace");
    expect(compareRoute).not.toContain("ResponsiveWorkspace");
  });

  test("app features do not own viewport gates or resize listeners", () => {
    const featureSources = [...readTree("client/src/components"), ...readTree("client/src/routes")];

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

  test("route-level page composition uses named content-width tiers", () => {
    const pageOwners = [
      "client/src/components/HomePage.tsx",
      "client/src/components/CarsPage.tsx",
      "client/src/components/SessionsPage.tsx",
      "client/src/components/TrackViewer.tsx",
      "client/src/components/track/TrackDetail.tsx",
      "client/src/components/ForzaLiveDashboard.tsx",
      "client/src/components/f1/F1LiveDashboard.tsx",
      "client/src/components/acc/AccLiveDashboard.tsx",
      "client/src/components/tunes/ExperimentList.tsx",
      "client/src/components/tunes/ExperimentWorkspace.tsx",
      "client/src/routes/dash.index.tsx",
    ];

    for (const path of pageOwners) {
      const source = read(path);
      expect(source).toMatch(/@(?:3xl|5xl|7xl)\/workspace:/);
      expect(source).not.toMatch(/(?:^|[\s"'`])(?:sm|md|lg|xl|2xl):/);
    }
  });

  test("app shell and full-screen flows own named container contracts", () => {
    const owners = [
      ["client/src/routes/__root.tsx", "@container/shell"],
      ["client/src/components/Settings.tsx", "@container/settings"],
      ["client/src/components/Onboarding.tsx", "@container/onboarding"],
      ["client/src/components/analyse/DataGuideModal.tsx", "@container/data-guide"],
      ["client/src/components/analyse/TuneViewModal.tsx", "@container/tune-view"],
      ["client/src/components/tunes/SetupFilePicker.tsx", "@container/setup-file"],
      ["client/src/components/ui/dialog.tsx", "@container/dialog"],
    ] as const;

    for (const [path, container] of owners) {
      expect(read(path)).toContain(container);
    }
  });
});
