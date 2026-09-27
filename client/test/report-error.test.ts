import { describe, expect, mock, test } from "bun:test";

const posts: Array<Record<string, unknown>> = [];
mock.module("../src/lib/rpc", () => ({
  client: {
    api: {
      "client-log": {
        $post: async ({ json }: { json: Record<string, unknown> }) => { posts.push(json); },
      },
    },
  },
}));

globalThis.window = { setTimeout } as unknown as Window & typeof globalThis;
const { reportClientError } = await import("../src/lib/report-error");

describe("client reporting", () => {
  test("forwards first occurrence timestamp through coalescing", async () => {
    const originalNow = Date.now;
    Date.now = () => 1234;
    reportClientError("test", "message", undefined, "info");
    Date.now = () => 5678;
    reportClientError("test", "message", undefined, "info");
    await new Promise<void>((resolve) => setTimeout(resolve, 550));
    Date.now = originalNow;
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ level: "info", occurredAtMs: 1234, message: "message [repeated 2 times]" });
  });
});
