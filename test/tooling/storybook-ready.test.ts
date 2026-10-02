import { describe, expect, test } from "bun:test";
import { openStory } from "../../client/src/stories/storybook-ready";

function storyPage(navigate: () => Promise<void>, renderError: string | null = null) {
  return {
    goto: navigate,
    locator: () => ({
      filter: () => ({
        first: () => ({ waitFor: async () => {} }),
      }),
      isVisible: async () => renderError !== null,
      locator: () => ({ textContent: async () => renderError }),
    }),
  };
}

describe("openStory", () => {
  test("reports a terminal story error without retrying it", async () => {
    let navigations = 0;
    const page = storyPage(async () => {
      if (++navigations > 1) throw new Error("A terminal render error must not be reloaded");
    }, "No QueryClient set, use QueryClientProvider to set one");

    await expect(openStory(page as never, "/iframe.html?id=setups", 10_000)).rejects.toThrow(
      "Storybook failed to render /iframe.html?id=setups: No QueryClient set, use QueryClientProvider to set one",
    );
  });

  test("retries transient navigation failure and reaches ready content", async () => {
    let ready = false;
    let attempts = 0;
    const page = storyPage(async () => {
      if (attempts++ === 0) throw new Error("Connection reset");
      ready = true;
    });

    await openStory(page as never, "/iframe.html?id=theme", 10_000);
    expect(ready).toBe(true);
  });

  test("preserves the final navigation error when both attempts fail", async () => {
    const errors = [new Error("Connection reset"), new Error("Server unavailable")];
    const page = storyPage(async () => { throw errors.shift(); });

    await expect(openStory(page as never, "/iframe.html?id=theme", 10_000)).rejects.toThrow("Server unavailable");
  });
});
