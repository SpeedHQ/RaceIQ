import { describe, expect, test } from "bun:test";
import { createStore } from "@tanstack/react-store";
import { getTanStackStoreSnapshots } from "../src/devtools/TanStackStoreDevtoolsPanel";

describe("TanStack Store devtools panel", () => {
  test("exposes named live snapshots for each registered store", () => {
    const alpha = createStore({ count: 1 });
    const beta = createStore({ ready: true });

    expect(getTanStackStoreSnapshots([
      { name: "Alpha", store: alpha },
      { name: "Beta", store: beta },
    ])).toEqual([
      { name: "Alpha", state: { count: 1 } },
      { name: "Beta", state: { ready: true } },
    ]);
  });
});
