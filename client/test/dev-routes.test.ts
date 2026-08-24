import { describe, expect, test } from "bun:test";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "../src/routeTree.gen";

describe("Dev routes", () => {
  test("exposes every dev panel as a direct route", () => {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/dev/state"] }) });
    expect(Object.keys(router.routesById)).toEqual(expect.arrayContaining(["/dev", "/dev/state", "/dev/telemetry", "/dev/speech", "/dev/e2e", "/dev/import"]));
  });
});
