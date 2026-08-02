import { describe, expect, spyOn, test } from "bun:test";
import { superviseSource } from "../server/runtime/source-supervisor";

interface TestSource {
  start(): void;
  stop(): Promise<void>;
}

describe("native telemetry source supervisor", () => {
  test("contains factory failures and leaves the source retryable", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    let current: TestSource | null = null;

    try {
      expect(() =>
        superviseSource(
          true,
          "Test",
          () => {
            throw new Error("factory failed");
          },
          () => current,
          (source) => {
            current = source;
          },
        ),
      ).not.toThrow();
      expect(current).toBeNull();
      expect(error).toHaveBeenCalledWith(
        "[Server] Test source start failed:",
        "factory failed",
      );
    } finally {
      error.mockRestore();
    }
  });

  test("contains start failures, cleans up, and retries next tick", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    let current: TestSource | null = null;
    let attempts = 0;
    let stops = 0;

    try {
      const tick = () =>
        superviseSource(
          true,
          "Test",
          () => {
            attempts++;
            return {
              start() {
                if (attempts === 1) throw new Error("start failed");
              },
              async stop() {
                stops++;
              },
            };
          },
          () => current,
          (source) => {
            current = source;
          },
        );

      expect(tick).not.toThrow();
      expect(current).toBeNull();
      expect(stops).toBe(1);

      expect(tick).not.toThrow();
      expect(current).not.toBeNull();
      expect(attempts).toBe(2);
      expect(error).toHaveBeenCalledWith(
        "[Server] Test source start failed:",
        "start failed",
      );
    } finally {
      error.mockRestore();
    }
  });
});
