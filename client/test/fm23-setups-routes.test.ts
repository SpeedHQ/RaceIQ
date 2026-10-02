import { describe, expect, test } from "bun:test";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "../src/routeTree.gen";

describe("FM23 setup routes", () => {
  test("exposes car tunes without wheel or FFB routes", () => {
    const router = createRouter({ routeTree, history: createMemoryHistory() });
    const routeIds = Object.keys(router.routesById);

    expect(routeIds).toContain("/fm23/setups/");
    expect(routeIds.some((id) => id.startsWith("/fm23/setups/wheel"))).toBe(false);
  });
});
