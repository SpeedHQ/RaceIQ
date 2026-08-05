import { describe, expect, test } from "bun:test";
import { openStory } from "../client/src/stories/storybook-ready";

describe("openStory", () => {
  test("applies readiness timeout to navigation", async () => {
    const calls: unknown[][] = [];
    const page = {
      goto: async (...args: unknown[]) => {
        calls.push(args);
      },
      locator: () => ({
        first: () => ({
          waitFor: async (...args: unknown[]) => {
            calls.push(args);
          },
        }),
      }),
    };

    await openStory(page as never, "/iframe.html?id=theme", 10_000);

    expect(calls).toEqual([
      ["/iframe.html?id=theme", { waitUntil: "commit", timeout: 10_000 }],
      [{ state: "visible", timeout: 10_000 }],
    ]);
  });
});
