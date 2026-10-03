import { ROOT_DIR } from "@raceiq/backend-core/runtime/config/paths";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(ROOT_DIR, ".", path), "utf8");

function readTree(path: string) {
  const sources: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) sources.push(readFileSync(entryPath, "utf8"));
    }
  };
  visit(resolve(ROOT_DIR, ".", path));
  return sources;
}

describe("responsive workspace contract", () => {
  test("app shell owns one shared container boundary for every route", () => {
    const workspace = read("client/src/components/ResponsiveWorkspace");
    const root = read("client/src/routes/__root");
    const analyseRoute = read("client/src/routes/$gameid/sessions.analyse");
    const compareRoute = read("client/src/routes/$gameid/compare");

    expect(workspace).toContain("@container/workspace");
    expect(workspace).toContain("overflow-x-hidden");
    expect(root).toContain("<ResponsiveWorkspace>");
    expect(analyseRoute).not.toContain("ResponsiveWorkspace");
    expect(compareRoute).not.toContain("ResponsiveWorkspace");
  });

  test("app features do not own viewport gates or resize listeners", () => {
    const featureSources = [...readTree("client/src/components"), ...readTree("client/src/routes/index")];

    for (const source of featureSources) {
      expect(source).not.toContain("window.innerWidth");
      expect(source).not.toContain("window.innerHeight");
      expect(source).not.toContain('addEventListener("resize"');
      expect(source).not.toContain("orientationchange");
      expect(source).not.toContain("MobileNotSupported");
    }
  });

  test("blocking rotation and unsupported helpers stay removed", () => {
    const root = read("client/src/routes/__root");
    const sessions = read("client/src/components/sessions/SessionsPage");
    const dash = read("client/src/routes/portable.index");

    expect(root).not.toContain("function MobileNotSupported");
    expect(root).not.toContain("function RotatePrompt");
    for (const source of [sessions, dash]) {
      expect(source).not.toContain("RotatePrompt");
    }
  });

  test("dense workspaces define stacked and wide compositions", () => {
    const analysePanels = read("client/src/components/analyse/AnalyseWorkspacePanels");
    const compare = read("client/src/components/comparison/LapComparison");
    const analyseTop = read("client/src/components/analyse/AnalyseTopSection");

    expect(analysePanels).toContain("@5xl/workspace:flex-row");
    expect(compare).toContain("@5xl/workspace:flex-row");
    expect(analyseTop).toContain("@5xl/workspace:flex-row");
  });

  test("analyse track sizing stays CSS-owned", () => {
    const trackPanel = read("client/src/components/analyse/AnalyseTrackPanel");
    const trackMap = read("client/src/components/analyse/AnalyseTrackMap");
    const liveDashboard = read("client/src/components/tunes/LiveTestDashboard");

    expect(trackPanel).not.toContain("containerHeight");
    expect(trackMap).not.toContain("containerHeight");
    expect(trackPanel).toContain("h-full");
    expect(liveDashboard).toContain("h-[22.5rem]");
  });

  test("route-level page composition uses named content-width tiers", () => {
    const pageOwners = [
      "client/src/components/home/HomePageView",
      "client/src/components/cars/CarsPage",
      "client/src/components/sessions/SessionDesktopTable",
      "client/src/components/TrackViewer",
      "client/src/components/track/TrackDetail",
      "client/src/components/ForzaLiveDashboard",
      "client/src/components/f1/F1LiveDashboard",
      "client/src/components/acc/AccLiveDashboard",
      "client/src/components/tunes/experiment/ExperimentList",
      "client/src/components/tunes/ExperimentWorkspace",
      "client/src/routes/portable.index",
    ];

    for (const path of pageOwners) {
      const source = read(path);
      expect(source).toMatch(/@(?:3xl|5xl|7xl)\/workspace:/);
      expect(source).not.toMatch(/(?:^|[\s"'`])(?:sm|md|lg|xl|2xl):/);
    }
  });

  test("app shell and full-screen flows own named container contracts", () => {
    const owners = [
      ["client/src/routes/__root", "@container/shell"],
      ["client/src/components/settings/Settings", "@container/settings"],
      ["client/src/components/onboarding/OnboardingModal", "@container/onboarding"],
      ["client/src/components/analyse/DataGuideModal", "@container/data-guide"],
      ["client/src/components/analyse/TuneViewModal", "@container/tune-view"],
      ["client/src/components/tunes/SetupFilePicker", "@container/setup-file"],
      ["client/src/components/ui/dialog", "@container/dialog"],
    ] as const;

    for (const [path, container] of owners) {
      expect(read(path)).toContain(container);
    }
  });
});
