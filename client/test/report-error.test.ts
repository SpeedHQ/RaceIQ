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

// Load after mock.module so the reporter binds the intentionally mocked RPC transport.
const { reportClientError, setClientErrorReportingEnabled } = await import("../src/lib/report-error");

describe("client reporting", () => {
  test("queues diagnostics until authorized and preserves first occurrence through coalescing", async () => {
    setClientErrorReportingEnabled(false);
    const originalNow = Date.now;
    Date.now = () => 1234;
    reportClientError("test", "message", undefined, "info");
    Date.now = () => 5678;
    reportClientError("test", "message", undefined, "info");
    await new Promise<void>((resolve) => setTimeout(resolve, 550));
    Date.now = originalNow;
    expect(posts).toEqual([]);
    setClientErrorReportingEnabled(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ level: "info", occurredAtMs: 1234, message: "message [repeated 2 times]" });
    setClientErrorReportingEnabled(false);
  });
});
