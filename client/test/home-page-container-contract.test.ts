import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const homePagePath = new URL("../src/components/home/HomePageView.tsx", import.meta.url);
const containerPath = new URL("../src/components/home/HomePageContainer.tsx", import.meta.url);
const routePaths = [
  "../src/routes/index.tsx",
  "../src/routes/fm23/index.tsx",
  "../src/routes/f125/index.tsx",
  "../src/routes/acc/index.tsx",
  "../src/routes/ac-evo/index.tsx",
  "../src/routes/iracing/index.tsx",
];

describe("dashboard HomePage boundary", () => {
  test("keeps HomePage pure and routes data through HomePageContainer", async () => {
    const homePage = await readFile(homePagePath, "utf8");
    const container = await readFile(containerPath, "utf8");
    const routes = await Promise.all(routePaths.map((path) => readFile(new URL(path, import.meta.url), "utf8")));

    expect(homePage).not.toMatch(/useQuery|useMutation|useGameId|useUiStore|client\.api|fetch\s*\(/);
    expect(container).toContain("export function HomePageContainer");
    for (const route of routes) {
      expect(route).toContain("HomePageContainer");
    }
  });
});
